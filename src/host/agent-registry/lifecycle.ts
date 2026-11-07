import { modelSelectionCleared } from "../model-catalog-settings.ts";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionIdentity } from "../../sdk/extensions.ts";
import { storedStartupProfile } from "../../startup-profile.ts";
import { copySessionMessageAttachments, createSessionBranch } from "../../store/session-branch.ts";
import { SessionStore, defaultSessionPath } from "../../store/session-store.ts";
import { ProviderUnavailableError, UserFacingError } from "../../user-facing-error.ts";
import { delegationAllows, isSessionIdentity, materializeSessionIdentity, publishBranchAttachments, removePublishedBranchAttachments, type PublishedBranchAttachments } from "./helpers.ts";
import { LIVE_IDLE_WINDOW_MS, entryIsLive, entryUpdatedAt, resolveAgentWorkspace, type BoundSessionIdentity, type BranchRegisteredAgentOptions, type BranchedRegisteredAgent, type CloseAgentTreeResult, type CloseDescendantTreeResult, type ClosedMember, type CreateRegisteredAgentOptions, type InheritedAgentSettings, type RegisteredAgentEntry, type RegisteredAgentKind, type ResumeRegisteredAgentOptions } from "./support.ts";
import { ResidentAgent } from "../resident-agent.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import { announceSessionEnd } from "./session-end.ts";
import type { SessionArtifacts } from "../session-trash.ts";

export async function create(reg: AgentRegistry, options: CreateRegisteredAgentOptions): Promise<ResidentAgent> {
        return reg.createWithKind(
            options,
            "interactive",
            options.approvalMode === undefined
                ? undefined
                : { approvalMode: options.approvalMode },
        );
    }

export async function closeAgent(reg: AgentRegistry, id: string, reason: SessionEndReason = "closed"): Promise<"closed" | "not_found"> {
        const entry = reg.agents.get(id);
        if (entry === undefined) {
            return "not_found";
        }
        entry.agent.close();
        await entry.run;
        announceSessionEnd(reg, entry, reason);
        await reg.reapClosedAgent(id, entry);
        reg.notifyRosterChanged();
        return "closed";
    }

export function ownedTreeIds(reg: AgentRegistry, id: string): readonly string[] {
        return reg.agents.has(id) ? [id, ...reg.liveDescendantsOf(id)] : [];
    }

// Returns "busy" without closing anything while a trash holds the id.
export async function closeAgentTree(reg: AgentRegistry, id: string, reason: SessionEndReason = "closed"): Promise<CloseAgentTreeResult> {
        if (reg.trashingIds.has(id)) {
            return { status: "busy", sessionRetained: true, closed: [] };
        }
        return closeTree(reg, id, reason);
    }

// Unguarded: a trash closes the tree it holds.
async function closeTree(reg: AgentRegistry, id: string, reason: SessionEndReason): Promise<CloseAgentTreeResult> {
        const present = reg.agents.has(id);
        const sessionRetained = reg.agents.get(id)?.ephemeral !== true;
        const quiesced = new Map<string, RegisteredAgentEntry>();
        while (true) {
            const members = [id, ...reg.liveDescendantsOf(id)]
                .filter((memberId) =>
                    reg.agents.has(memberId) && !quiesced.has(memberId)
                );
            if (members.length === 0) {
                break;
            }
            for (const memberId of members) {
                const entry = reg.agents.get(memberId);
                if (entry !== undefined) {
                    reg.closingCompletionRecipients.add(entry.store);
                    entry.agent.close();
                }
            }
            for (const memberId of members) {
                const entry = reg.agents.get(memberId);
                if (entry === undefined) {
                    continue;
                }
                await entry.run;
                quiesced.set(memberId, entry);
            }
        }
        const closed: ClosedMember[] = [];
        for (const [memberId, entry] of quiesced) {
            announceSessionEnd(reg, entry, reason);
            await reg.reapClosedAgent(memberId, entry);
            if (!entry.ephemeral) {
                closed.push({ id: memberId, sessionPath: entry.store.path });
            }
        }
        if (quiesced.size > 0) {
            reg.notifyRosterChanged();
        }
        return {
            status: present || quiesced.size > 0 ? "closed" : "not_found",
            sessionRetained,
            closed,
        };
    }

export async function parkExpiredIdle(reg: AgentRegistry, now = Date.now()): Promise<readonly ClosedMember[]> {
        const closed: ClosedMember[] = [];
        if (reg.isClosed) return closed;
        const expiredRoots: string[] = [];
        for (const [id, entry] of reg.agents) {
            if (reg.startingIds.has(id)) continue;
            if (entry.parentId !== undefined && reg.agents.has(entry.parentId)) {
                continue;
            }
            if (!treeIdleForPark(reg, id)) continue;
            const latest = treeUpdatedAt(reg, id);
            if (!Number.isFinite(latest)) continue;
            if (now - latest < LIVE_IDLE_WINDOW_MS) continue;
            expiredRoots.push(id);
        }
        for (const id of expiredRoots) {
            if (reg.isClosed || !reg.agents.has(id)) continue;
            try {
                closed.push(...(await closeAgentTree(reg, id, "idle")).closed);
            } catch {
                // A failed park must not stop the rest of the sweep.
            }
        }
        return closed;
    }

function treeIdleForPark(reg: AgentRegistry, id: string): boolean {
        return [id, ...reg.liveDescendantsOf(id)].every((memberId) => {
            const entry = reg.agents.get(memberId);
            return entry !== undefined && entry.agent.idleForShutdown();
        });
    }

function treeUpdatedAt(reg: AgentRegistry, id: string): number {
        let latest = Number.NaN;
        for (const memberId of [id, ...reg.liveDescendantsOf(id)]) {
            const entry = reg.agents.get(memberId);
            if (entry === undefined) continue;
            const updated = Date.parse(entryUpdatedAt(entry));
            if (!Number.isFinite(updated)) continue;
            latest = Number.isFinite(latest) ? Math.max(latest, updated) : updated;
        }
        return latest;
    }

export async function closeDescendantTree(reg: AgentRegistry, callerId: string, targetId: string): Promise<CloseDescendantTreeResult> {
        const target = reg.agents.get(targetId);
        if (
            target === undefined
            || target.agent.closed
            || target.agent.failed
            || target.failure !== undefined
        ) {
            return { status: "not_found", sessionRetained: true, closed: [] };
        }
        const caller = reg.agents.get(callerId);
        if (
            caller === undefined
            || caller.agent.closed
            || caller.agent.failed
            || caller.failure !== undefined
            || !reg.liveDescendantsOf(callerId).includes(targetId)
        ) {
            return { status: "not_owned", sessionRetained: true };
        }

        if (
            target.parentId === callerId
            && (
                target.pendingAsyncTurns > 0
                || target.pendingCompletionDeliveries > 0
            )
        ) {
            reg.suppressedCompletionDeliveries.add(target);
        }
        try {
            const result = await reg.closeAgentTree(targetId);
            if (result.status === "busy") {
                reg.suppressedCompletionDeliveries.delete(target);
            } else if (result.status === "closed" && result.sessionRetained) {
                await reportClosedMembers(reg, result.closed);
            }
            return result;
        } catch (error) {
            reg.suppressedCompletionDeliveries.delete(target);
            throw error;
        }
    }

// Awaited so the listing is current before the caller sees the result.
async function reportClosedMembers(reg: AgentRegistry, members: readonly ClosedMember[]): Promise<void> {
        const onSessionsClosed = reg.options.onSessionsClosed;
        if (onSessionsClosed === undefined || members.length === 0) {
            return;
        }
        try {
            await onSessionsClosed(members);
        } catch {
            // The sessions stay on disk and are found again at the next host start.
        }
    }

// A second closer of the same entry finds it already reaped, or replaced by a restart it must not remove.
export async function reapClosedAgent(reg: AgentRegistry, id: string, entry: RegisteredAgentEntry): Promise<void> {
        if (reg.agents.get(id) !== entry) {
            return;
        }
        entry.inbox?.release();
        reg.agents.delete(id);
        reg.spawnNotices.delete(id);
        if (entry.ephemeral) {
            await rm(dirname(entry.store.path), { recursive: true, force: true });
        }
    }

export function liveDescendantsOf(reg: AgentRegistry, id: string): readonly string[] {
        const ordered: string[] = [];
        const seen = new Set<string>([id]);
        const visit = (parentId: string): void => {
            for (const [childId, entry] of reg.agents) {
                if (entry.parentId !== parentId || seen.has(childId)) {
                    continue;
                }
                seen.add(childId);
                visit(childId);
                ordered.push(childId);
            }
        };
        visit(id);
        return ordered;
    }

export async function createWithKind(reg: AgentRegistry, options: CreateRegisteredAgentOptions, kind: RegisteredAgentKind, inherited?: InheritedAgentSettings, clientPromptRefusal?: string): Promise<ResidentAgent> {
        const id = options.id ?? randomUUID();
        if (inherited?.parentId !== undefined) {
            requireNotTrashing(reg, inherited.parentId);
        }
        reg.reserveId(id);
        let createdPath: string | undefined;
        let ephemeralDirectory: string | undefined;
        try {
            const workspace = await resolveAgentWorkspace(options.workspace);
            const startupProfile = storedStartupProfile(
                options.startupProfile ?? "default",
            );
            ephemeralDirectory = options.ephemeral === true
                ? await mkdtemp(join(tmpdir(), "vera-ephemeral-agent-"))
                : undefined;
            const store = await SessionStore.create(
                options.sessionPath
                    ?? (ephemeralDirectory === undefined
                        ? undefined
                        : join(ephemeralDirectory, `${id}.jsonl`))
                    ?? reg.options.sessionPathForId?.(id)
                    ?? defaultSessionPath(id),
                {
                    sessionId: id,
                    cwd: workspace,
                    ...(startupProfile === undefined
                        ? {}
                        : { contextAssemblyMode: startupProfile }),
                    ...(inherited?.parentId === undefined
                        ? {}
                        : { parentId: inherited.parentId }),
                    ...(inherited?.delegation === undefined
                        ? {}
                        : { delegation: inherited.delegation }),
                },
            );
            createdPath = store.path;
            if (inherited !== undefined) {
                await store.appendApprovalMode(inherited.approvalMode);
                if (inherited.modelSettings !== undefined) {
                    await store.appendModelSettings(inherited.modelSettings);
                }
            }
            reg.requireOpen();
            return await reg.start(
                store,
                kind,
                options.eventLogPath,
                inherited?.parentId,
                clientPromptRefusal,
                options.ephemeral === true,
            );
        } catch (error) {
            await abandonStart(reg, id);
            if (ephemeralDirectory !== undefined) {
                await rm(ephemeralDirectory, { recursive: true, force: true })
                    .catch(() => {});
            } else if (createdPath !== undefined) {
                await rm(createdPath, { force: true }).catch(() => {});
            }
            throw error;
        } finally {
            reg.startingIds.delete(id);
        }
    }

export async function resume(reg: AgentRegistry, options: ResumeRegisteredAgentOptions): Promise<ResidentAgent> {
        const sessionPath = await realpath(options.sessionPath);
        const store = await SessionStore.open(sessionPath);
        const blocked = reg.blockRefusalFor(store.header.id);
        if (blocked !== undefined) {
            throw new UserFacingError(blocked);
        }
        const storedProvider = store.modelSettings()?.provider;
        if (
            store.header.delegation !== undefined
            && store.modelSettings() !== undefined
            && !delegationAllows(
                store.header.delegation,
                store.modelSettings()!,
            )
        ) {
            throw new UserFacingError(
                "This delegated session's stored model is outside its persisted boundary.",
            );
        }
        if (
            store.agentFailure() === undefined
            && storedProvider !== undefined
            && !(storedProvider === "unknown" && reg.defaultProvider === "unknown")
            && !modelSelectionCleared(store.modelSettings())
            && !reg.isKnownProvider(storedProvider)
        ) {
            throw new ProviderUnavailableError(storedProvider);
        }
        const parentId = store.header.delegation?.parentId
            ?? store.header.parentId;
        if (parentId !== undefined) {
            requireNotTrashing(reg, parentId);
        }
        reg.reserveId(store.header.id);
        try {
            reg.requireOpen();
            return await reg.start(
                store,
                parentId === undefined ? "interactive" : "background",
                options.eventLogPath,
                parentId,
                undefined,
                false,
                false,
                "resume",
            );
        } catch (error) {
            // The session file is the user's conversation, so it stays.
            await abandonStart(reg, store.header.id);
            throw error;
        } finally {
            reg.startingIds.delete(store.header.id);
        }
    }

export async function branch(reg: AgentRegistry, options: BranchRegisteredAgentOptions): Promise<BranchedRegisteredAgent | undefined> {
        if (options.ephemeral === true && options.sessionPath !== undefined) {
            throw new Error("An ephemeral branch cannot use a session path");
        }
        options.signal?.throwIfAborted();
        const ephemeralDirectory = options.ephemeral === true
            ? await mkdtemp(join(tmpdir(), "vera-ephemeral-agent-"))
            : undefined;
        // A branch copies the source's completed entries, so a source that is
        // mid-turn still branches: the unfinished turn is not in the copy.
        const source = reg.agents.get(options.sourceId);
        if (
            source === undefined
            || source.agent.closed
            || source.agent.failed
        ) {
            if (ephemeralDirectory !== undefined) {
                await rm(ephemeralDirectory, { recursive: true, force: true });
            }
            return undefined;
        }
        const id = options.id ?? randomUUID();
        let createdPath: string | undefined;
        let stagingPath: string | undefined;
        let publishedAttachments: PublishedBranchAttachments | undefined;
        // reserveId throws when another call owns the id; cleanup must not close that agent.
        let reserved = false;
        const approvalMode = options.approvalMode ?? source.approvalMode;
        try {
            reg.reserveId(id);
            reserved = true;
            const destinationPath = options.sessionPath
                ?? (ephemeralDirectory === undefined
                    ? undefined
                    : join(ephemeralDirectory, `${id}.jsonl`))
                ?? reg.options.sessionPathForId?.(id)
                ?? defaultSessionPath(id);
            stagingPath = options.ephemeral === true
                ? destinationPath
                : join(
                    dirname(destinationPath),
                    `.${basename(destinationPath)}.${randomUUID()}.branch`,
                );
            const created = await createSessionBranch({
                source: source.store,
                destinationPath: stagingPath,
                sessionId: id,
                position: options.position,
                ...(options.entryId === undefined
                    ? {}
                    : { entryId: options.entryId }),
                ...(options.hideInheritedMessages === true
                    ? { hideInheritedMessages: true }
                    : {}),
            });
            options.signal?.throwIfAborted();
            await created.store.appendApprovalMode(approvalMode);
            for (const message of options.initialMessages ?? []) {
                options.signal?.throwIfAborted();
                await created.store.appendMessage(message);
            }
            options.signal?.throwIfAborted();
            let store = created.store;
            if (options.ephemeral !== true) {
                publishedAttachments = await publishBranchAttachments(
                    stagingPath,
                    destinationPath,
                    options.signal,
                );
                options.signal?.throwIfAborted();
                await link(stagingPath, destinationPath);
                createdPath = destinationPath;
                await rm(stagingPath, { force: true });
                stagingPath = undefined;
                store = await SessionStore.open(destinationPath);
            } else {
                createdPath = stagingPath;
            }
            reg.requireOpen();
            return {
                agent: await reg.start(
                    store,
                    "interactive",
                    options.eventLogPath,
                    undefined,
                    undefined,
                    options.ephemeral === true,
                    options.deferPublication === true,
                ),
                ...(created.prompt === undefined
                    ? {}
                    : { prompt: created.prompt }),
            };
        } catch (error) {
            if (reserved) {
                await abandonStart(reg, id);
            }
            if (ephemeralDirectory !== undefined) {
                await rm(ephemeralDirectory, { recursive: true, force: true })
                    .catch(() => {});
            } else if (createdPath !== undefined) {
                await rm(createdPath, { force: true }).catch(() => {});
                await rm(`${createdPath}.attachments`, {
                    recursive: true,
                    force: true,
                }).catch(() => {});
            }
            if (stagingPath !== undefined) {
                await rm(stagingPath, { force: true }).catch(() => {});
                await rm(`${stagingPath}.attachments`, {
                    recursive: true,
                    force: true,
                }).catch(() => {});
            }
            if (publishedAttachments !== undefined) {
                await removePublishedBranchAttachments(publishedAttachments);
            }
            throw error;
        } finally {
            if (reserved) {
                reg.startingIds.delete(id);
            }
        }
    }

export async function trashSession(reg: AgentRegistry, targetId: string): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        if (reg.trashingIds.has(targetId) || reg.startingIds.has(targetId)) {
            return "busy";
        }
        const entry = reg.agents.get(targetId);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return "not_found";
        }
        const descendants = reg.liveDescendantsOf(targetId).flatMap(
            (id) => reg.agents.get(id) ?? [],
        );
        if (
            !entry.agent.idleForShutdown()
            || entry.pendingAsyncTurns > 0
            || entry.pendingCompletionDeliveries > 0
            || descendants.some(descendantBlocksTrash)
            || descendants.some((member) => reg.trashingIds.has(member.agent.id))
        ) {
            return "busy";
        }

        // Parents first, so a restart registers a child after its parent.
        const restartable = [
            restartPlan(reg, entry),
            ...descendants.toReversed().filter(entryIsLive)
                .map((member) => restartPlan(reg, member)),
        ];
        // The reservation spans the close, the move and any restart, so no member registers in between.
        const reserved = [entry.agent.id, ...descendants.map((member) => member.agent.id)];
        for (const id of reserved) {
            reg.trashingIds.add(id);
        }
        try {
            const closed = [...(await closeTree(reg, targetId, "deleted")).closed];
            try {
                await reg.trashArtifacts({
                    sessionPath: entry.store.path,
                    attachmentsPath: `${entry.store.path}.attachments`,
                    eventLogPath: entry.eventLogPath,
                });
            } catch {
                await restartClosedAgents(reg, restartable);
                // Members that did not restart stay closed and listed, the target among them.
                await reportClosedMembers(reg, closed);
                return "failed";
            }
            // A child whose resume began before the reservation can register during the move.
            closed.push(...(await closeTree(reg, targetId, "deleted")).closed);
            // The target's file is gone; its children's files stay and stay listed.
            await reportClosedMembers(
                reg,
                closed.filter((member) => member.id !== targetId),
            );
            return "trashed";
        } finally {
            for (const id of reserved) {
                reg.trashingIds.delete(id);
            }
        }
    }

// For a session with no resident agent. The reservation refuses a resume until the move ends.
export async function trashStoredSession(
    reg: AgentRegistry,
    targetId: string,
    locate: () => Promise<SessionArtifacts | undefined>,
): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        const entry = reg.agents.get(targetId);
        if (
            reg.trashingIds.has(targetId)
            || reg.startingIds.has(targetId)
            || (entry !== undefined && !entry.agent.closed && !entry.agent.failed)
        ) {
            return "busy";
        }
        reg.trashingIds.add(targetId);
        try {
            const artifacts = await locate();
            if (artifacts === undefined) {
                return "not_found";
            }
            try {
                await reg.trashArtifacts(artifacts);
            } catch {
                return "failed";
            }
            return "trashed";
        } finally {
            reg.trashingIds.delete(targetId);
        }
    }

function requireNotTrashing(reg: AgentRegistry, id: string): void {
        if (reg.trashingIds.has(id)) {
            throw new UserFacingError("This conversation is being moved to the trash.");
        }
    }

function descendantBlocksTrash(entry: RegisteredAgentEntry): boolean {
        if (!entryIsLive(entry)) {
            return false;
        }
        return !entry.completed
            || entry.pendingCompletionDeliveries > 0
            || !entry.agent.idleForShutdown();
    }

interface RestartPlan {
        readonly id: string;
        readonly sessionPath: string;
        readonly kind: RegisteredAgentKind;
        readonly eventLogPath: string | undefined;
        readonly parentId: string | undefined;
        // A child can be resident while its parent is not; that child restarts as it was.
        readonly parentRegistered: boolean;
        readonly completed: boolean;
    }

function restartPlan(reg: AgentRegistry, entry: RegisteredAgentEntry): RestartPlan {
        return {
            id: entry.agent.id,
            sessionPath: entry.store.path,
            kind: entry.kind,
            eventLogPath: entry.eventLogPath,
            parentId: entry.parentId,
            parentRegistered: entry.parentId !== undefined
                && reg.agents.has(entry.parentId),
            completed: entry.completed,
        };
    }

// A child whose parent is in the plan restarts only after that parent restarted and is still live.
async function restartClosedAgents(reg: AgentRegistry, plans: readonly RestartPlan[]): Promise<void> {
        const planned = new Set(plans.map((plan) => plan.id));
        const restarted = new Set<string>();
        for (const plan of plans) {
            if (reg.isClosed) {
                return;
            }
            if (!parentAcceptsRestart(reg, plan, planned, restarted)) {
                continue;
            }
            if (!(await restartClosedAgent(reg, plan))) {
                continue;
            }
            // A restart awaits before it registers, so the host may have closed or the parent's trash begun.
            if (reg.isClosed) {
                await abandonStart(reg, plan.id, "shutdown");
                return;
            }
            if (!parentAcceptsRestart(reg, plan, planned, restarted)) {
                await abandonStart(reg, plan.id, "deleted");
                continue;
            }
            restarted.add(plan.id);
        }
    }

// A parent outside the plan may have been closed or trashed while this move ran.
function parentAcceptsRestart(
    reg: AgentRegistry,
    plan: RestartPlan,
    planned: ReadonlySet<string>,
    restarted: ReadonlySet<string>,
): boolean {
        const parentId = plan.parentId;
        if (parentId === undefined) {
            return true;
        }
        if (planned.has(parentId)) {
            // A restart can register a session that already failed, or fail once its loop starts.
            const parent = reg.agents.get(parentId);
            return restarted.has(parentId)
                && parent !== undefined
                && entryIsLive(parent);
        }
        if (reg.trashingIds.has(parentId)) {
            return false;
        }
        const parent = reg.agents.get(parentId);
        return !plan.parentRegistered
            || (parent !== undefined && entryIsLive(parent));
    }

async function restartClosedAgent(reg: AgentRegistry, plan: RestartPlan): Promise<boolean> {
        try {
            const store = await SessionStore.open(plan.sessionPath);
            await reg.start(
                store,
                plan.kind,
                plan.eventLogPath,
                plan.parentId,
                undefined,
                false,
                false,
                "resume",
            );
        } catch {
            await abandonStart(reg, plan.id);
            return false;
        }
        const restarted = reg.agents.get(plan.id);
        if (restarted !== undefined && plan.completed) {
            restarted.completed = true;
        }
        return true;
    }

// start() registers the entry before it can still throw; a left-over entry would block a later resume.
async function abandonStart(reg: AgentRegistry, id: string, reason?: SessionEndReason): Promise<void> {
        const started = reg.agents.get(id);
        if (started === undefined) {
            return;
        }
        // Without a loop no session_start went out, so no session_end may follow.
        if (started.loopServices === undefined) {
            started.sessionEnded = true;
        }
        await reg.closeAgent(id, reason).catch(() => {});
    }

export function find(reg: AgentRegistry, id: string): ResidentAgent | undefined {
        const entry = reg.agents.get(id);
        const agent = entry?.pendingPublication === true
            ? undefined
            : entry?.agent;
        return agent?.closed === false ? agent : undefined;
    }

export function commitBranch(reg: AgentRegistry, id: string): boolean {
        const entry = reg.agents.get(id);
        if (entry === undefined || !entry.pendingPublication) {
            return false;
        }
        entry.pendingPublication = false;
        reg.notifyRosterChanged();
        reg.announceSessionUpdated(entry);
        return true;
    }

export async function syncBranchContext(reg: AgentRegistry, targetId: string): Promise<{
        readonly status:
            | "synced"
            | "unchanged"
            | "busy"
            | "stale_cursor"
            | "not_found";
        readonly turns: number;
    }> {
        const target = reg.agents.get(targetId);
        const sourceId = target?.store.header.origin?.sessionId;
        const source = sourceId === undefined
            ? undefined
            : reg.agents.get(sourceId);
        if (target === undefined || source === undefined) {
            return { status: "not_found", turns: 0 };
        }
        if (
            target.agent.closed
            || target.agent.failed
            || source.agent.closed
            || source.agent.failed
            || target.agent.status !== "idle"
            || source.agent.status !== "idle"
            || target.inbound === undefined
        ) {
            return { status: "busy", turns: 0 };
        }
        const active = source.store.activeEntries();
        const lastCompletedIndex = active.findLastIndex((entry) =>
            entry.message.role === "assistant"
        );
        if (lastCompletedIndex < 0) {
            return { status: "unchanged", turns: 0 };
        }
        const completed = active.slice(0, lastCompletedIndex + 1);
        const cursor = target.syncedSourceEntryId
            ?? target.store.header.origin?.entryId
            ?? null;
        const cursorIndex = cursor === null
            ? -1
            : completed.findIndex((entry) => entry.id === cursor);
        if (cursor !== null && cursorIndex < 0) {
            return { status: "stale_cursor", turns: 0 };
        }
        const additions = completed.slice(cursorIndex + 1);
        const turns = additions.filter((entry) =>
            entry.message.role === "user"
            && entry.message.internal !== true
        ).length;
        if (additions.length === 0 || turns === 0) {
            return { status: "unchanged", turns: 0 };
        }
        await copySessionMessageAttachments(
            source.store,
            target.store,
            additions.map((entry) => entry.message),
        );
        const appended = await target.inbound.appendContext(
            additions.map((entry) => entry.message),
            {
                text: `Caught up with ${turns} new ${turns === 1 ? "turn" : "turns"} from the primary conversation.`,
                tone: "soft",
            },
        );
        if (!appended) {
            return { status: "busy", turns: 0 };
        }
        target.syncedSourceEntryId = additions.at(-1)!.id;
        return { status: "synced", turns };
    }

export function arcNameOf(reg: AgentRegistry, id: string): string | undefined {
        const entry = reg.agents.get(id);
        return entry?.agent.closed === false ? entry.identity?.name : undefined;
    }

export function agentIdForArcSession(reg: AgentRegistry, value: string): string | undefined {
        for (const [id, entry] of reg.agents) {
            if (entry.agent.closed) {
                continue;
            }
            const identity = entry.identity;
            if (identity === undefined) {
                continue;
            }
            if (value === identity.name || value === identity.key) {
                return id;
            }
            const incoming = reg.options.sessionIdentity?.keyOf?.(value);
            if (incoming != null && incoming === identity.key) {
                return id;
            }
        }
        return reg.find(value)?.id;
    }

export function identityKeyTaken(reg: AgentRegistry, key: string): boolean {
        if (
            reg.identityKeyOwners.has(key)
            || reg.unavailableIdentityKeys.has(key)
        ) {
            return true;
        }
        for (const entry of reg.agents.values()) {
            if (entry.identity?.key === key) {
                return true;
            }
        }
        return false;
    }

export async function bindSessionIdentity(reg: AgentRegistry, store: SessionStore): Promise<BoundSessionIdentity | undefined> {
        const stored = store.identity();
        if (stored !== undefined) {
            const claimed = await reg.claimSessionIdentityKey(
                store.header.id,
                stored.key,
            );
            if (!claimed) {
                throw new Error(
                    `Session identity ${stored.name} is already owned by another session`,
                );
            }
            return materializeSessionIdentity(stored.name, stored.key);
        }
        if (store.agentFailure() !== undefined) {
            return undefined;
        }
        const provider = reg.options.sessionIdentity;
        if (provider === undefined) {
            return undefined;
        }
        let minted: SessionIdentity | undefined;
        for (let attempt = 0; attempt < 1_024; attempt += 1) {
            minted = provider.mint({
                taken: (key) => reg.identityKeyTaken(key),
            });
            if (!isSessionIdentity(minted)) {
                throw new Error(
                    "Session identity provider returned an invalid identity",
                );
            }
            if (await reg.claimSessionIdentityKey(store.header.id, minted.key)) {
                break;
            }
            minted = undefined;
        }
        if (minted === undefined) {
            throw new Error("Session identity provider exhausted its name space");
        }
        await store.appendIdentity({
            name: minted.name,
            key: minted.key,
        });
        return materializeSessionIdentity(minted.name, minted.key);
    }

export async function claimSessionIdentityKey(reg: AgentRegistry, sessionId: string, key: string): Promise<boolean> {
        const owner = reg.identityKeyOwners.get(key);
        if (owner !== undefined) {
            return owner === sessionId;
        }
        if (reg.unavailableIdentityKeys.has(key)) {
            return false;
        }
        // Reserve locally before awaiting the durable claim. Concurrent creates in this host must not both offer the same candidate.
        reg.identityKeyOwners.set(key, sessionId);
        const reserve = reg.options.reserveSessionIdentity;
        if (reserve === undefined) {
            return true;
        }
        try {
            const outcome = await reserve(sessionId, key);
            if (outcome === "reserved" || outcome === "owned") {
                return true;
            }
            reg.identityKeyOwners.delete(key);
            reg.unavailableIdentityKeys.add(key);
            return false;
        } catch (error) {
            reg.identityKeyOwners.delete(key);
            throw error;
        }
    }

export function idleForShutdown(reg: AgentRegistry): boolean {
        return reg.startingIds.size === 0
            && reg.trashingIds.size === 0
            && reg.deliveryTasks.size === 0
            && !reg.processRegistry.hasLiveProcesses()
            && [...reg.agents.values()].every(
                (entry) => entry.agent.idleForShutdown(),
            );
    }

export function idleForReplacement(reg: AgentRegistry): boolean {
        return reg.startingIds.size === 0
            && reg.trashingIds.size === 0
            && reg.deliveryTasks.size === 0
            && !reg.processRegistry.hasLiveProcesses()
            && [...reg.agents.values()].every(
                (entry) => entry.agent.idleForReplacement(),
            );
    }

export async function close(reg: AgentRegistry): Promise<void> {
        reg.isClosed = true;
        const entries = [...reg.agents.values()];
        for (const entry of entries) {
            entry.inbox?.release();
            entry.agent.close();
        }
        await Promise.all([
            reg.processRegistry.close(),
            ...entries.map((entry) => entry.run),
        ]);
        for (const entry of entries) {
            announceSessionEnd(reg, entry, "shutdown");
        }
        await Promise.all([...reg.deliveryTasks]);
        await Promise.all(entries
            .filter((entry) => entry.ephemeral)
            .map((entry) => rm(dirname(entry.store.path), {
                recursive: true,
                force: true,
            })));
    }

export function reserveId(reg: AgentRegistry, id: string): void {
        reg.requireOpen();
        requireNotTrashing(reg, id);
        if (reg.agents.has(id) || reg.startingIds.has(id)) {
            throw new Error(`Resident agent ${id} already exists`);
        }
        reg.startingIds.add(id);
    }

export function requireOpen(reg: AgentRegistry): void {
        if (reg.isClosed) {
            throw new Error("Agent registry is closed");
        }
    }
