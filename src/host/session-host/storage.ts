import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { availableModels, contextWindowForModel, type ModelWindowEntry } from "../../engine/model-settings.ts";
import { readModelFailures } from "../../store/model-failures.ts";
import {
    latestFailureBySession,
    readSessionFacts,
    type SessionFactName,
    type SessionFacts,
} from "../../store/session-facts.ts";
import type { HostLog } from "../host-log.ts";

import { readSessionIndexMetadata } from "../../store/session-store.ts";
import {
    type AgentRegistry,
    importedSessionSummary,
    type ClosedMember,
    type RegisteredAgentSummary,
} from "../agent-registry.ts";
import type { ResidentAgent } from "../resident-agent.ts";

export type RestoringSessions = Map<string, Promise<void>>;

export async function withSessionReservation<T>(
    sessionPath: string,
    inFlight: RestoringSessions,
    run: (canonicalPath: string) => Promise<T>,
): Promise<T> {
    return await withSessionReservations([sessionPath], inFlight, async ([canonicalPath]) =>
        await run(canonicalPath!)
    );
}

export async function withSessionReservations<T>(
    sessionPaths: readonly string[],
    inFlight: RestoringSessions,
    run: (canonicalPaths: readonly string[]) => Promise<T>,
): Promise<T> {
    const canonicalPaths = [...new Set(await Promise.all(sessionPaths.map((path) => realpath(path))))];
    const previous = canonicalPaths.flatMap((path) => {
        const pending = inFlight.get(path);
        return pending === undefined ? [] : [pending];
    });
    const result = Promise.all(previous).then(() => run(canonicalPaths));
    const settled = result.then(() => undefined, () => undefined);
    for (const path of canonicalPaths) inFlight.set(path, settled);
    try {
        return await result;
    } finally {
        for (const path of canonicalPaths) {
            if (inFlight.get(path) === settled) inFlight.delete(path);
        }
    }
}

export async function resumeOrFind(
    registry: AgentRegistry,
    sessionPath: string,
    inFlight: RestoringSessions = new Map(),
    ownershipTransfer = false,
): Promise<ResidentAgent> {
    return await withSessionReservation(sessionPath, inFlight, async (canonicalPath) =>
        await resumeReserved(registry, canonicalPath, ownershipTransfer)
    );
}

export async function resumeReserved(
    registry: AgentRegistry,
    sessionPath: string,
    ownershipTransfer = false,
): Promise<ResidentAgent> {
    const canonicalPath = await realpath(sessionPath);
    for (const summary of registry.list()) {
        let existingPath = summary.session_path;
        if (existingPath !== canonicalPath) {
            existingPath = await realpath(existingPath).catch(() => existingPath);
        }
        if (existingPath === canonicalPath) {
            const agent = registry.find(summary.id);
            if (agent !== undefined) return agent;
        }
    }
    return await registry.resume({ sessionPath: canonicalPath, ownershipTransfer });
}

export async function findOrRestoreAgent(
    registry: AgentRegistry,
    agentId: string,
    sessionDirectory: string,
    storedSessions: Promise<ReadonlyMap<string, RegisteredAgentSummary>>,
    resume: (sessionPath: string) => Promise<ResidentAgent>,
): Promise<ResidentAgent | undefined> {
    const existing = registry.find(agentId);
    if (existing !== undefined) return existing;
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
    const conventionalPath = join(sessionDirectory, `${agentId}.jsonl`);
    try {
        return await resume(conventionalPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const indexed = (await storedSessions).get(agentId);
    return indexed === undefined ? undefined : resume(indexed.session_path);
}

// A member that restarted is resident and listed as such.
export async function indexClosedMembers(
    registry: AgentRegistry,
    members: readonly ClosedMember[],
    index: Map<string, RegisteredAgentSummary>,
): Promise<void> {
    for (const member of members) {
        if (!registry.agents.has(member.id)) {
            await indexStoredSession(member.sessionPath, index);
        }
    }
}

// A resident agent's file need not sit in sessionDirectory.
export function commandSessionPath(
    registry: AgentRegistry,
    sessionId: string,
    sessionDirectory: string,
    index: ReadonlyMap<string, RegisteredAgentSummary>,
): string {
    return registry.agents.get(sessionId)?.store.path
        ?? index.get(sessionId)?.session_path
        ?? join(sessionDirectory, `${sessionId}.jsonl`);
}

export async function storedSessionExists(
    agentId: string,
    sessionDirectory: string,
    index: ReadonlyMap<string, RegisteredAgentSummary>,
): Promise<boolean> {
    return (await storedSessionPath(agentId, sessionDirectory, index))
        !== undefined;
}

export async function storedSessionPath(
    agentId: string,
    sessionDirectory: string,
    index: ReadonlyMap<string, RegisteredAgentSummary>,
): Promise<string | undefined> {
    const indexed = index.get(agentId)?.session_path;
    if (indexed !== undefined) return indexed;
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
        return undefined;
    }
    const conventional = join(sessionDirectory, `${agentId}.jsonl`);
    try {
        return (await stat(conventional)).isFile() ? conventional : undefined;
    } catch {
        return undefined;
    }
}

export async function indexStoredSessions(
    sessionDirectory: string,
    sessions = new Map<string, RegisteredAgentSummary>(),
    log: HostLog = () => {},
): Promise<ReadonlyMap<string, RegisteredAgentSummary>> {
    let names: readonly string[];
    try {
        names = await readdir(sessionDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            log({
                type: "session_index_failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
        return sessions;
    }
    for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
        await indexStoredSession(join(sessionDirectory, name), sessions);
    }
    return sessions;
}

export async function indexStoredSession(
    path: string,
    sessions: Map<string, RegisteredAgentSummary>,
): Promise<void> {
    try {
        const metadata = await readSessionIndexMetadata(path);
        const header = metadata.header;
        const fileStat = await stat(path).catch(() => undefined);
        const size = fileStat?.size;
        sessions.set(header.id, {
            id: header.id,
            workspace: header.cwd,
            session_path: path,
            kind: header.delegation?.kind === "subagent"
                ? "background"
                : "interactive",
            status: "completed",
            live: false,
            updated_at: fileStat?.mtime.toISOString() ?? header.timestamp,
            created_at: header.timestamp,
            ...(metadata.title === undefined
                ? {}
                : { title: metadata.title.slice(0, 80) }),
            has_user_content: metadata.hasUserContent,
            ...(header.origin === undefined
                ? {}
                : { forked_from: header.origin.sessionId }),
            ...importedSessionSummary(header),
            ...(header.delegation?.parentId === undefined
                && header.parentId === undefined
                ? {}
                : {
                    parent_id: header.delegation?.parentId ?? header.parentId,
                }),
            ...(size === undefined ? {} : { size_bytes: size }),
        });
    } catch {
        // A corrupt unopened session cannot block healthy lazy resumes.
    }
}

export async function enrichSessionsWithFacts(
    sessions: readonly RegisteredAgentSummary[],
    include: readonly SessionFactName[],
    ledgerPath: string,
    windows: readonly ModelWindowEntry[],
): Promise<readonly RegisteredAgentSummary[]> {
    const failures = include.includes("failure")
        ? latestFailureBySession(readModelFailures(ledgerPath))
        : undefined;
    return await Promise.all(sessions.map(async (session) => {
        const facts = await readSessionFacts(session.session_path, {
            include,
            capacity: (provider, model) =>
                contextWindowForModel(provider, model, windows, availableModels()),
        });
        const failure = failures?.get(session.id);
        const merged: SessionFacts = {
            ...facts,
            ...(failure === undefined ? {} : { failure }),
        };
        return Object.keys(merged).length === 0
            ? session
            : { ...session, facts: merged };
    }));
}

export function mergeStoredAndResidentAgents(
    stored: ReadonlyMap<string, RegisteredAgentSummary>,
    resident: readonly RegisteredAgentSummary[],
): RegisteredAgentSummary[] {
    const merged = new Map(stored);
    for (const agent of resident) merged.set(agent.id, agent);
    return [...merged.values()].sort((left, right) =>
        left.id.localeCompare(right.id)
    );
}

