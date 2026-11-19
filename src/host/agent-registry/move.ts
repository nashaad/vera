import { realpath, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { chatFolderPath, isChatFolder } from "../../store/chat-folder.ts";
import { rewriteSessionCwd } from "../../store/session-cwd.ts";
import { SessionStore, sessionIsSubagent } from "../../store/session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { closeTree, reportClosedMembers, restartClosedAgents, restartPlan } from "./lifecycle.ts";
import {
    firstCollision,
    moveEventLog,
    moveFolderContents,
    returnEntries,
    returnFolderContents,
    topLevelNames,
} from "./move-files.ts";
import { entryIsLive, type ClosedMember, type RegisteredAgentEntry } from "./support.ts";

export interface MoveSessionInput {
    readonly workspace: string;
}

export type MoveSessionOutcome =
    | { readonly status: "moved"; readonly workspace: string }
    | { readonly status: "invalid" | "busy" | "not_found" | "collision" | "failed" };

type MoveFailure = Exclude<MoveSessionOutcome, { readonly status: "moved" }>;

interface MoveSubject {
    readonly id: string;
    readonly sessionPath: string;
    readonly cwd: string;
    readonly eventLogPath: string | undefined;
}

interface EventLogMove {
    readonly from: string;
    readonly to: string;
}

interface MovePlan {
    readonly sessionPath: string;
    readonly workspace: string;
    readonly chatFolder: string | undefined;
    readonly eventLog: EventLogMove | undefined;
    // Where a restarted session logs: the new key once the move succeeds.
    readonly eventLogPath: string | undefined;
}

class MoveRefusal extends Error {
    constructor(readonly status: "collision") {
        super(status);
    }
}

export async function moveSession(
    reg: AgentRegistry,
    id: string,
    request: MoveSessionInput,
    sessionsDirectory: string,
): Promise<MoveSessionOutcome> {
    if (reg.trashingIds.has(id) || reg.startingIds.has(id)) return { status: "busy" };
    const entry = reg.agents.get(id);
    if (entry === undefined || entry.agent.closed || entry.agent.failed) return { status: "not_found" };
    if (entry.ephemeral || entry.parentId !== undefined || sessionIsSubagent(entry.store.header)) {
        return { status: "invalid" };
    }
    const planned = await planMove(reg, {
        id,
        sessionPath: entry.store.path,
        cwd: entry.store.header.cwd,
        eventLogPath: entry.eventLogPath,
    }, request, sessionsDirectory, [entry.agent.workspace]);
    if ("status" in planned) return planned;

    // The checks and the reservation share one synchronous step, so nothing registers in between.
    if (reg.agents.get(id) !== entry || reg.trashingIds.has(id) || reg.startingIds.has(id) || !idleToMove(reg, entry)) {
        return { status: "busy" };
    }
    const restartable = [restartPlan(reg, entry)];
    reserve(reg, id);
    try {
        let closed: ClosedMember[];
        try {
            closed = [...(await closeTree(reg, id, "closed")).closed];
        } catch {
            await restartClosedAgents(reg, restartable);
            return { status: "failed" };
        }
        try {
            await applyPlan(planned);
        } catch (error) {
            await restartClosedAgents(reg, restartable);
            await reportClosedMembers(reg, closed);
            return error instanceof MoveRefusal ? { status: error.status } : { status: "failed" };
        }
        // A child whose resume began before the reservation can register during the move.
        closed.push(...(await closeTree(reg, id, "closed")).closed);
        await restartClosedAgents(reg, restartable.map((plan) => plan.id === id && planned.eventLogPath !== undefined
            ? { ...plan, eventLogPath: planned.eventLogPath }
            : plan));
        await reportClosedMembers(reg, closed);
        reg.notifyRosterChanged();
        return { status: "moved", workspace: planned.workspace };
    } finally {
        release(reg, id);
    }
}

// For a session with no resident agent. The reservation refuses a resume until the move ends.
export async function moveStoredSession(
    reg: AgentRegistry,
    id: string,
    request: MoveSessionInput,
    sessionsDirectory: string,
    locate: () => Promise<string | undefined>,
): Promise<MoveSessionOutcome> {
    const entry = reg.agents.get(id);
    if (
        reg.trashingIds.has(id)
        || reg.startingIds.has(id)
        || (entry !== undefined && !entry.agent.closed && !entry.agent.failed)
    ) {
        return { status: "busy" };
    }
    reserve(reg, id);
    try {
        const sessionPath = await locate();
        if (sessionPath === undefined) return { status: "not_found" };
        let store: SessionStore;
        try {
            store = await SessionStore.open(sessionPath);
        } catch {
            return { status: "failed" };
        }
        if (sessionIsSubagent(store.header)) return { status: "invalid" };
        const planned = await planMove(reg, {
            id,
            sessionPath,
            cwd: store.header.cwd,
            eventLogPath: reg.options.eventLogPathForId?.(store.header.id, store.header.cwd),
        }, request, sessionsDirectory, []);
        if ("status" in planned) return planned;
        try {
            await applyPlan(planned);
        } catch (error) {
            return error instanceof MoveRefusal ? { status: error.status } : { status: "failed" };
        }
        reg.notifyRosterChanged();
        return { status: "moved", workspace: planned.workspace };
    } finally {
        release(reg, id);
    }
}

function reserve(reg: AgentRegistry, id: string): void {
    reg.trashingIds.add(id);
    reg.movingIds.add(id);
}

function release(reg: AgentRegistry, id: string): void {
    reg.movingIds.delete(id);
    reg.trashingIds.delete(id);
}

// A move closes the session, so anything a client or a turn is still waiting on blocks it.
function idleToMove(reg: AgentRegistry, entry: RegisteredAgentEntry): boolean {
    return entryIsLive(entry)
        && entry.agent.idleForReplacement()
        && entry.pendingAsyncTurns === 0
        && entry.pendingCompletionDeliveries === 0
        && reg.liveDescendantsOf(entry.agent.id).length === 0;
}

async function planMove(
    reg: AgentRegistry,
    subject: MoveSubject,
    request: MoveSessionInput,
    sessionsDirectory: string,
    currentAliases: readonly string[],
): Promise<MovePlan | MoveFailure> {
    const workspace = await existingDirectory(request.workspace);
    if (workspace === undefined) return { status: "invalid" };
    const chatFolder = chatFolderPath(subject.sessionPath);
    const inChatFolder = isChatFolder(subject.sessionPath, subject.cwd);
    for (const path of [subject.cwd, ...currentAliases]) {
        if (workspace === await realpath(path).catch(() => path)) return { status: "invalid" };
    }
    const ownFolder = await realpath(chatFolder).catch(() => chatFolder);
    if (within(workspace, ownFolder)) return { status: "invalid" };
    const sessions = await realpath(sessionsDirectory).catch(() => sessionsDirectory);
    if (within(workspace, sessions)) return { status: "invalid" };

    if (inChatFolder) {
        try {
            const names = await topLevelNames(chatFolder);
            if (await firstCollision(names, workspace) !== undefined) return { status: "collision" };
        } catch {
            return { status: "failed" };
        }
    }

    // With no event log recorded the restart derives its path from the new cwd itself.
    const from = subject.eventLogPath;
    const to = from === undefined ? undefined : reg.options.eventLogPathForId?.(subject.id, workspace);
    return {
        sessionPath: subject.sessionPath,
        workspace,
        chatFolder: inChatFolder ? chatFolder : undefined,
        eventLog: from !== undefined && to !== undefined && to !== from ? { from, to } : undefined,
        eventLogPath: to,
    };
}

function within(candidate: string, folder: string): boolean {
    return candidate === folder || candidate.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

async function existingDirectory(path: string): Promise<string | undefined> {
    if (!isAbsolute(path)) return undefined;
    try {
        const resolved = await realpath(path);
        return (await stat(resolved)).isDirectory() ? resolved : undefined;
    } catch {
        return undefined;
    }
}

// Files, the event log and the header move in that order; a later failure puts the earlier steps back.
async function applyPlan(plan: MovePlan): Promise<void> {
    const undo: Array<() => Promise<void>> = [];
    try {
        if (plan.chatFolder !== undefined) {
            const outcome = await moveFolderContents(plan.chatFolder, plan.workspace);
            if (outcome.status === "collision") throw new MoveRefusal("collision");
            if (outcome.status !== "moved") throw new Error("The chat files could not be moved.");
            const { names } = outcome;
            const chatFolder = plan.chatFolder;
            undo.push(() => returnFolderContents(chatFolder, plan.workspace, names));
        }
        if (plan.eventLog !== undefined) {
            const moved = await moveEventLog(plan.eventLog.from, plan.eventLog.to);
            undo.push(() => returnEntries(moved));
        }
        await rewriteSessionCwd(plan.sessionPath, plan.workspace);
    } catch (error) {
        for (const step of undo.toReversed()) await step().catch(() => {});
        throw error;
    }
}
