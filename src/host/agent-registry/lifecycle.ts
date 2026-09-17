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
import { LIVE_IDLE_WINDOW_MS, entryUpdatedAt, resolveAgentWorkspace, type BoundSessionIdentity, type BranchRegisteredAgentOptions, type BranchedRegisteredAgent, type CloseAgentTreeResult, type CloseDescendantTreeResult, type CreateRegisteredAgentOptions, type InheritedAgentSettings, type RegisteredAgentEntry, type RegisteredAgentKind, type ResumeRegisteredAgentOptions } from "./support.ts";
import { ResidentAgent } from "../resident-agent.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export async function create(reg: AgentRegistry, options: CreateRegisteredAgentOptions): Promise<ResidentAgent> {
        return reg.createWithKind(
            options,
            "interactive",
            options.approvalMode === undefined
                ? undefined
                : { approvalMode: options.approvalMode },
        );
    }

export async function closeAgent(reg: AgentRegistry, id: string): Promise<"closed" | "not_found"> {
        const entry = reg.agents.get(id);
        if (entry === undefined) {
            return "not_found";
        }
        entry.agent.close();
        await entry.run;
        await reg.reapClosedAgent(id, entry);
        reg.notifyRosterChanged();
        return "closed";
    }

export function ownedTreeIds(reg: AgentRegistry, id: string): readonly string[] {
        return reg.agents.has(id) ? [id, ...reg.liveDescendantsOf(id)] : [];
    }

export async function closeAgentTree(reg: AgentRegistry, id: string): Promise<CloseAgentTreeResult> {
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
        for (const [memberId, entry] of quiesced) {
            await reg.reapClosedAgent(memberId, entry);
        }
        if (quiesced.size > 0) {
            reg.notifyRosterChanged();
        }
        return {
            status: present || quiesced.size > 0 ? "closed" : "not_found",
            sessionRetained,
        };
    }

export async function parkExpiredIdle(reg: AgentRegistry, now = Date.now()): Promise<void> {
        if (reg.isClosed) return;
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
                await closeAgentTree(reg, id);
            } catch {
                // A failed park must not stop the rest of the sweep.
            }
        }
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
            return { status: "not_found", sessionRetained: true };
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
            return await reg.closeAgentTree(targetId);
        } catch (error) {
            reg.suppressedCompletionDeliveries.delete(target);
            throw error;
        }
    }

export async function reapClosedAgent(reg: AgentRegistry, id: string, entry: RegisteredAgentEntry): Promise<void> {
        entry.inbox?.release();
        await entry.projectExtensions?.close();
        await reg.options.releaseWorkspaceSidecars?.(entry.store.header.cwd);
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
            await reg.closeAgent(id).catch(() => {});
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
        reg.reserveId(store.header.id);
        try {
            reg.requireOpen();
            const parentId = store.header.delegation?.parentId
                ?? store.header.parentId;
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
        const source = reg.agents.get(options.sourceId);
        if (
            source === undefined
            || source.agent.closed
            || source.agent.failed
            || source.agent.status !== "idle"
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
        const approvalMode = options.approvalMode ?? source.approvalMode;
        try {
            reg.reserveId(id);
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
            reg.startingIds.delete(id);
        }
    }

export async function trashSession(reg: AgentRegistry, targetId: string): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        const entry = reg.agents.get(targetId);
        if (entry === undefined || entry.agent.closed || entry.agent.failed) {
            return "not_found";
        }
        if (
            entry.kind !== "interactive"
            || !entry.agent.idleForShutdown()
            || [...reg.agents.values()].some(
                (candidate) =>
                    candidate.parentId === targetId
                    && candidate.failure === undefined
                    && !candidate.agent.failed
                    && !candidate.agent.closed
                    && (
                        !candidate.completed
                        || candidate.pendingCompletionDeliveries > 0
                    ),
            )
        ) {
            return "busy";
        }

        await reg.closeAgent(targetId);
        try {
            await reg.trashArtifacts({
                sessionPath: entry.store.path,
                attachmentsPath: `${entry.store.path}.attachments`,
                eventLogPath: entry.eventLogPath,
            });
            return "trashed";
        } catch {
            try {
                const store = await SessionStore.open(entry.store.path);
                await reg.start(
                    store,
                    entry.kind,
                    entry.eventLogPath,
                    undefined,
                    undefined,
                    false,
                    false,
                    "resume",
                );
            } catch {
            }
            return "failed";
        }
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
            && reg.deliveryTasks.size === 0
            && !reg.processRegistry.hasLiveProcesses()
            && [...reg.agents.values()].every(
                (entry) => entry.agent.idleForShutdown(),
            );
    }

export function idleForReplacement(reg: AgentRegistry): boolean {
        return reg.startingIds.size === 0
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
