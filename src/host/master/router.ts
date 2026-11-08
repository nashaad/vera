import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { CreateRegisteredAgentOptions, RegisteredAgentSummary, RenameSessionOutcome } from "../agent-registry.ts";
import type { AgentLocationFailedResponse, AgentLocationResponse, BlockSessionRequest, UnblockSessionRequest } from "../protocol.ts";
import type { BlockSessionOutcome, CloseAgentOutcome, UnblockSessionOutcome } from "../server.ts";
import { UserFacingError, userFacingMessage } from "../../user-facing-error.ts";
import type { SessionEndReason } from "../../sdk/hooks.ts";
import type { SessionFactName } from "../../store/session-facts.ts";
import type { SessionSearchQuery, SessionSearchResults } from "../../store/session-search.ts";
import type { ExtensionSessionAskCall, ExtensionInvestigateCall } from "../../extensions/host-services.ts";
import type { VeraInvestigateResult, VeraSessionAskResult, VeraSessionSendOutcome, VeraSessionTitleOutcome } from "../../sdk/extensions.ts";
import type { ExtensionSessionServices } from "../session-host/types.ts";
import type { PeerCaller, PeerRosterEntry, PeerSessionServices } from "../agent-registry/peer-services.ts";
import type { AgentSendEffect, ToolOutput } from "../../tools/types.ts";
import type { BranchSyncOutcome } from "../agent-registry/context-sync.ts";
import type { SessionImportOutcome, ImportableSessionListing } from "../session-import-service.ts";
import type { ParentDeliveryOutcome, SubagentAdmission, SubagentSessionServices } from "../agent-registry/subagent-services.ts";
import { readSessionSnapshot, type PendingDelivery } from "../../store/session-store.ts";
import type { MessageSubagentEffect } from "../../tools/types.ts";
import type { ToolApprovalUiRequestUpdate } from "../../engine/protocol.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import type { AttachmentTreeReader } from "../attachment-coordinator.ts";
import { LIVE_IDLE_WINDOW_MS } from "../agent-registry/support.ts";
import { mergeRosters, type SessionOwner, type WorkerOwner } from "./roster.ts";
import { sessionShardIndex } from "../shard.ts";
import type { InspectedSession, OwnedSession, RoutedSession, SessionEndpoint } from "./session-endpoint.ts";
import { blockAcrossOwners, unblockAcrossOwners } from "./block.ts";
import { searchAcrossOwners } from "./search.ts";
import { trashAcrossOwners, type PreparedTrash } from "./trash.ts";
import { closeAcrossOwners } from "./close.ts";
import { recoveryFileStamp, sameRecoveryFile, type RecoveryFileStamp } from "./recovery-file.ts";
export type { RoutedSession, SessionEndpoint, SessionResumeOptions, SessionSnapshot } from "./session-endpoint.ts";

export class SessionTransferReservationsChanged extends Error {}

interface WaitForOperation {
    readonly wait: Promise<void>;
}

class OwnershipPending extends Error {
    constructor(readonly wait: Promise<void>) {
        super("Session ownership is pending");
    }
}

interface OperationCompletion {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

interface StoredTrash {
    readonly storedOwner: SessionOwner;
}

interface PendingRecoveryOpen {
    readonly owner: WorkerOwner;
    readonly path: string;
    readonly baseline: string | null;
    readonly file: RecoveryFileStamp | null;
    readonly confirmed: boolean;
    revision: number;
    opening: boolean;
}

export interface WorkerRecoverySession {
    readonly id: string;
    readonly path: string;
    readonly baseline?: string | null;
    readonly file?: RecoveryFileStamp | null;
}

export interface HostRouterOptions {
    readonly master: SessionEndpoint;
    readonly worker: SessionEndpoint;
    readonly masterSocket: string;
    readonly workerSocket: string;
    readonly buildId: string;
    readonly workerGeneration?: () => number;
    readonly workerReady?: () => boolean;
    readonly extraWorkers?: readonly RouterWorker[];
    readonly keepResidentOwner?: boolean;
    readonly sessionPathForId?: (id: string) => string | undefined;
    readonly reserveDelivery?: (id: string, run: () => Promise<ParentDeliveryOutcome>) => Promise<ParentDeliveryOutcome>;
}

export interface RouterWorker {
    readonly id: WorkerOwner;
    readonly endpoint: SessionEndpoint;
    readonly socket: string;
    readonly generation: () => number;
    readonly ready: () => boolean;
    readonly pid?: () => number | undefined;
}

export class HostRouter implements ExtensionSessionServices, PeerSessionServices, SubagentSessionServices, SubagentAdmission {
    private readonly owners = new Map<string, SessionOwner>();
    private readonly paths = new Map<string, string>();
    private readonly residents = new Map<string, SessionOwner>();
    private readonly recoveryOpens = new Map<string, PendingRecoveryOpen>();
    private recoveryRevision = 0;
    private readonly branches = new Map<string, number>();
    private readonly extensionOperations = new Map<string, number>();
    private readonly masterOpening = new Set<string>();
    private readonly masterOpeningPaths = new Map<string, string>();
    private readonly closing = new Map<string, number>();
    private readonly trashing = new Set<string>();
    private readonly subagentStarts = new Map<string, number>();
    private readonly subagentStartCompletions = new Map<string, OperationCompletion>();
    private readonly masterOpeningParents = new Map<string, string>();
    private readonly workerOpenings = new Map<string, WorkerOwner>();
    private readonly operationCompletions = new Map<string, OperationCompletion>();
    private pending: Promise<void> = Promise.resolve();
    private imports: Promise<void> = Promise.resolve();
    private readonly workers: readonly RouterWorker[];
    private readonly endpoints: ReadonlyMap<SessionOwner, SessionEndpoint>;

    constructor(private readonly options: HostRouterOptions) {
        this.workers = [{
            id: "w0", endpoint: options.worker, socket: options.workerSocket,
            generation: options.workerGeneration ?? (() => 1), ready: options.workerReady ?? (() => true),
        }, ...options.extraWorkers ?? []];
        this.endpoints = new Map<SessionOwner, SessionEndpoint>([
            ["host", options.master], ...this.workers.map((worker) => [worker.id, worker.endpoint] as const),
        ]);
    }

    snapshotRevision(): number { return this.recoveryRevision; }

    observe(owner: SessionOwner, sessions: readonly RoutedSession[], revision = this.recoveryRevision): void {
        const present = new Set(sessions.map((session) => session.id));
        for (const [id, current] of this.residents) {
            if (current === owner && !present.has(id)) this.residents.delete(id);
        }
        for (const session of sessions) {
            const current = this.owners.get(session.id);
            if (current === undefined || current === owner) {
                this.owners.set(session.id, owner);
                this.paths.set(session.id, session.sessionPath);
                this.residents.set(session.id, owner);
            }
        }
        for (const [id, opening] of this.recoveryOpens) {
            if (opening.owner === owner && !opening.opening && opening.revision <= revision) this.recoveryOpens.delete(id);
        }
    }

    observeStored(owner: SessionOwner, summaries: readonly RegisteredAgentSummary[]): void {
        for (const summary of summaries) {
            if (!this.owners.has(summary.id) && (owner === "host" || this.hashOwner(summary.id) === owner)) {
                this.owners.set(summary.id, owner);
            }
            if (this.owners.get(summary.id) === owner) this.paths.set(summary.id, summary.session_path);
        }
    }

    knownPath(id: string): string | undefined { return this.paths.get(id); }

    workerSessions(owner: WorkerOwner, held: readonly string[] = []): readonly WorkerRecoverySession[] {
        const sessions = new Map<string, WorkerRecoverySession>();
        for (const [id, current] of this.residents) {
            const path = this.paths.get(id);
            if (current === owner && path !== undefined) sessions.set(id, { id, path });
        }
        for (const [id, opening] of this.recoveryOpens) {
            if (opening.owner === owner && !sessions.has(id)) {
                sessions.set(id, opening.confirmed ? { id, path: opening.path }
                    : { id, path: opening.path, baseline: opening.baseline, file: opening.file });
            }
        }
        for (const id of held) {
            const path = this.paths.get(id) ?? this.recoveryOpens.get(id)?.path;
            if (path !== undefined) sessions.set(id, { id, path });
        }
        return [...sessions.values()];
    }

    private async beginRecoveryOpen(owner: SessionOwner, id: string, path?: string): Promise<PendingRecoveryOpen | undefined> {
        if (this.options.keepResidentOwner !== true || owner === "host" || path === undefined) return undefined;
        const existing = this.recoveryOpens.get(id);
        if (existing !== undefined && existing.owner === owner) {
            existing.opening = true;
            existing.revision = ++this.recoveryRevision;
            return existing;
        }
        let confirmed = this.residents.get(id) === owner;
        let baseline: string | null = null;
        let file: RecoveryFileStamp | null = null;
        if (!confirmed) {
            const before = await recoveryFileStamp(path);
            try {
                const snapshot = await readSessionSnapshot(path);
                const last = snapshot.messages.at(-1);
                baseline = last === undefined ? null : snapshot.messageStamps.get(last)?.id ?? null;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            file = await recoveryFileStamp(path);
            if (!sameRecoveryFile(before, file)) confirmed = true;
        }
        if (!this.worker(owner).ready()) throw new UserFacingError("The session worker is unavailable.");
        const opening: PendingRecoveryOpen = { owner, path, baseline, file, confirmed, revision: ++this.recoveryRevision, opening: true };
        this.recoveryOpens.set(id, opening);
        return opening;
    }

    private finishRecoveryOpen(id: string, opening: PendingRecoveryOpen | undefined): void {
        if (opening === undefined || this.recoveryOpens.get(id) !== opening) return;
        opening.opening = false;
        opening.revision = ++this.recoveryRevision;
    }

    cachedLocation(id: string): AgentLocationResponse | AgentLocationFailedResponse | undefined {
        if (this.options.keepResidentOwner !== true) return undefined;
        const owner = this.owners.get(id);
        if (owner === undefined || owner === "host") return undefined;
        const worker = this.worker(owner);
        if (!worker.ready()) {
            return { type: "agent_location_failed", reason: "worker_unavailable", message: "The session worker is unavailable." };
        }
        if (this.residents.get(id) !== owner || this.masterOpening.has(id)
            || this.trashing.has(id) || this.closing.has(id)) return undefined;
        return {
            type: "agent_location", socket_path: worker.socket, worker_id: owner,
            worker_generation: worker.generation(), build_id: this.options.buildId,
        };
    }

    create(options: Pick<CreateRegisteredAgentOptions,
        "workspace" | "approvalMode" | "ephemeral" | "startupProfile">): Promise<RoutedSession> {
        return this.serial(async () => {
            let id = randomUUID();
            while (this.masterOpening.has(id) || this.owners.has(id)
                || (await this.allResidents()).some((entry) => entry.session.id === id)) id = randomUUID();
            const available = this.workers.filter((worker) => worker.ready());
            if (available.length === 0) throw new UserFacingError("The session worker is unavailable.");
            const loads = await Promise.all(available.map(async (worker) => (await worker.endpoint.residents()).length));
            const chosen = available[loads.indexOf(Math.min(...loads))]!;
            this.owners.set(id, chosen.id);
            const opening = await this.beginRecoveryOpen(chosen.id, id,
                options.ephemeral === true ? undefined : this.options.sessionPathForId?.(id));
            try {
                const session = await chosen.endpoint.create({ ...options, id });
                if (session.id !== id) throw new Error("Session worker returned a different id");
                this.paths.set(id, session.sessionPath);
                this.residents.set(id, chosen.id);
                return session;
            } finally { this.finishRecoveryOpen(id, opening); }
        });
    }

    assertResumeAvailable(id: string, parentId?: string): void {
        if (this.trashing.has(id) || (parentId !== undefined && this.trashing.has(parentId))) {
            throw new UserFacingError("This conversation is being moved to the trash.");
        }
    }

    inspectForResume(path: string): Promise<InspectedSession> {
        return this.serial(async () => {
            const canonical = await this.options.master.canonicalPath(path);
            const name = basename(canonical);
            const id = name.endsWith(".jsonl") ? name.slice(0, -6) : undefined;
            const opening = this.masterOpeningPaths.get(canonical) ?? (id !== undefined && this.masterOpening.has(id) ? id : undefined);
            if (opening !== undefined) this.waitForOpen(opening);
            const inspected = await this.options.master.inspect(canonical);
            if (this.masterOpening.has(inspected.id)) this.waitForOpen(inspected.id);
            return inspected;
        });
    }

    async resume(path: string, reservedPaths?: ReadonlySet<string>): Promise<RoutedSession> {
        while (true) {
            const result = await this.serial(async (): Promise<RoutedSession | WaitForOperation> => {
                const canonical = await this.options.master.canonicalPath(path);
                const opening = this.masterOpeningPaths.get(canonical);
                if (opening !== undefined) this.waitForOpen(opening);
                const name = basename(canonical);
                const pathId = name.endsWith(".jsonl") ? name.slice(0, -6) : undefined;
                const pathOwner = pathId === undefined ? undefined : this.owners.get(pathId);
                if (pathId !== undefined && this.masterOpening.has(pathId)) this.waitForOpen(pathId);
                const inspected = await this.options.master.inspect(canonical);
                if (reservedPaths !== undefined && !reservedPaths.has(inspected.sessionPath)) {
                    throw new SessionTransferReservationsChanged();
                }
                if (this.masterOpening.has(inspected.id)) this.waitForOpen(inspected.id);
                this.assertResumeAvailable(inspected.id, inspected.parentId);
                const prior = inspected.id === pathId ? pathOwner : this.owners.get(inspected.id);
                if (this.options.keepResidentOwner === true) {
                    const selected = prior !== undefined && prior !== "host" ? prior : prior === "host" ? undefined : this.hashOwner(inspected.id);
                    if (selected !== undefined && !this.worker(selected).ready()) {
                        throw new UserFacingError("The session worker is unavailable.");
                    }
                }
                const residents = (await this.allResidents()).filter((entry) => entry.session.id === inspected.id);
                if (residents.length > 1) {
                    throw new Error("Session is resident on both hosts");
                }
                const resident = residents[0];
                if (this.options.keepResidentOwner === true && prior !== undefined
                    && resident !== undefined && resident.owner !== prior) {
                    throw new Error("Session ownership conflicts with its resident host");
                }
                const master = resident?.owner === "host" ? resident.session : undefined;
                if (resident !== undefined && (resident.owner !== "host" || this.options.keepResidentOwner === true)) {
                    if ((await this.endpoint(resident.owner).inspect(resident.session.sessionPath)).sessionPath !== inspected.sessionPath) {
                        throw new Error("Session id is already in use");
                    }
                    this.owners.set(inspected.id, resident.owner);
                    return resident.session;
                }
                if (master === undefined && this.extensionOperations.has(inspected.id)) {
                    return { wait: this.operationCompletions.get(inspected.id)!.promise };
                }
                let transferred: readonly RoutedSession[] = [];
                const owner = prior !== undefined && prior !== "host" ? prior : this.hashOwner(inspected.id);
                const worker = this.worker(owner);
                if (!worker.ready()) throw new UserFacingError("The session worker is unavailable.");
                if (master !== undefined) {
                    const tree = await this.options.master.tree(inspected.id);
                    if ((await this.options.master.inspect(master.sessionPath)).sessionPath !== inspected.sessionPath) {
                        throw new Error("Session id is already in use");
                    }
                    if (tree.some((id) => this.branches.has(id) || this.extensionOperations.has(id))) {
                        this.owners.set(inspected.id, "host");
                        return master;
                    }
                    const members = await Promise.all(tree.map((id) => this.options.master.resident(id)));
                    transferred = members.filter((member): member is RoutedSession => member !== undefined);
                    if (reservedPaths !== undefined) {
                        transferred = await Promise.all(transferred.map(async (member) => ({
                            ...member,
                            sessionPath: (await this.options.master.inspect(member.sessionPath)).sessionPath,
                        })));
                        if (transferred.some((member) => !reservedPaths.has(member.sessionPath))) {
                            throw new SessionTransferReservationsChanged();
                        }
                    }
                    const released = await this.options.master.release(inspected.id);
                    if (released === undefined) {
                        this.owners.set(inspected.id, "host");
                        return master;
                    }
                    for (const id of released) this.owners.set(id, owner);
                }
                this.owners.set(inspected.id, owner);
                const recoveryOpening = await this.beginRecoveryOpen(owner, inspected.id, inspected.sessionPath);
                let session: RoutedSession;
                try {
                    session = await worker.endpoint.resume(inspected.sessionPath, {
                        reserved: reservedPaths !== undefined,
                        ownershipTransfer: master !== undefined,
                    });
                } finally { this.finishRecoveryOpen(inspected.id, recoveryOpening); }
                this.paths.set(inspected.id, session.sessionPath);
                this.residents.set(inspected.id, owner);
                for (const member of transferred) {
                    if (member.id !== inspected.id) {
                        const memberOpening = await this.beginRecoveryOpen(owner, member.id, member.sessionPath);
                        try {
                            await worker.endpoint.resume(member.sessionPath, {
                                reserved: reservedPaths !== undefined,
                                ownershipTransfer: true,
                            });
                        } finally { this.finishRecoveryOpen(member.id, memberOpening); }
                    }
                }
                return session;
            });
            if (!("wait" in result)) return result;
            await result.wait;
        }
    }

    locate(id: string, reserved = false, path?: string): Promise<AgentLocationResponse | AgentLocationFailedResponse> {
        const cached = this.cachedLocation(id);
        if (cached !== undefined) return Promise.resolve(cached);
        return this.serial(async () => {
            try {
                const owner = await this.resolvedOwner(id) ?? this.hashOwner(id);
                if (owner !== "host" && !this.worker(owner).ready()) {
                    return { type: "agent_location_failed", reason: "worker_unavailable", message: "The session worker is unavailable." };
                }
                if (!this.owners.has(id)) this.owners.set(id, owner);
                const opening = await this.beginRecoveryOpen(owner, id, path ?? this.paths.get(id));
                let session: RoutedSession | undefined;
                try { session = await this.endpoint(owner).find(id, reserved); }
                finally { this.finishRecoveryOpen(id, opening); }
                if (session === undefined) {
                    return { type: "agent_location_failed", reason: "not_found", message: "No session with this id is on this host." };
                }
                this.owners.set(id, owner);
                this.paths.set(id, session.sessionPath);
                this.residents.set(id, owner);
                return {
                    type: "agent_location",
                    socket_path: owner === "host" ? this.options.masterSocket : this.worker(owner).socket,
                    worker_id: owner,
                    worker_generation: owner === "host" ? 1 : this.worker(owner).generation(),
                    build_id: this.options.buildId,
                };
            } catch (error) {
                if (error instanceof OwnershipPending) throw error;
                return {
                    type: "agent_location_failed", reason: "worker_unavailable",
                    message: userFacingMessage(error) ?? "The session could not be loaded.",
                };
            }
        });
    }

    find(owner: SessionOwner, id: string, reserved = false, path?: string): Promise<boolean> {
        return this.serial(async () => {
            const assigned = await this.resolvedOwner(id);
            if (assigned !== undefined && assigned !== owner) return false;
            if (assigned === undefined && (owner === "host" || owner !== this.hashOwner(id))) return false;
            if (owner !== "host" && !this.worker(owner).ready()) throw new UserFacingError("The session worker is unavailable.");
            if (assigned === undefined) this.owners.set(id, owner);
            const opening = await this.beginRecoveryOpen(owner, id, path ?? this.paths.get(id));
            let session: RoutedSession | undefined;
            try { session = await this.endpoint(owner).find(id, reserved); }
            finally { this.finishRecoveryOpen(id, opening); }
            if (session === undefined) return false;
            this.owners.set(id, owner);
            this.paths.set(id, session.sessionPath);
            this.residents.set(id, owner);
            return true;
        });
    }

    socketFor(from: SessionOwner, id: string): Promise<string | undefined> {
        return this.serial(async () => {
            const owner = await this.resolvedOwner(id) ?? this.hashOwner(id);
            if (owner !== "host" && !this.worker(owner).ready()) throw new UserFacingError("The session worker is unavailable.");
            if (owner === from) return undefined;
            return owner === "host" ? this.options.masterSocket : this.worker(owner).socket;
        });
    }

    beginBranch(owner: SessionOwner, id: string): Promise<boolean> {
        return this.serial(async () => {
            if (await this.claimOwner(id, false) !== owner) return false;
            this.branches.set(id, (this.branches.get(id) ?? 0) + 1);
            return true;
        });
    }

    endBranch(id: string): void {
        const count = this.branches.get(id);
        if (count === undefined || count <= 1) this.branches.delete(id);
        else this.branches.set(id, count - 1);
    }

    setSessionTitle(id: string, title: string): Promise<VeraSessionTitleOutcome> {
        return this.extensionOperation(id, (endpoint) => endpoint.setSessionTitle(id, title));
    }

    sendToSession(extensionId: string, id: string, text: string): Promise<VeraSessionSendOutcome> {
        return this.extensionOperation(id, (endpoint) => endpoint.sendToSession(extensionId, id, text));
    }

    askSession(call: ExtensionSessionAskCall, signal: AbortSignal): Promise<VeraSessionAskResult> {
        return this.extensionOperation(call.sessionId, (endpoint) => endpoint.askSession(call, signal));
    }

    investigate(call: ExtensionInvestigateCall, signal: AbortSignal): Promise<VeraInvestigateResult> {
        return this.extensionOperation(call.sessionId, (endpoint) => endpoint.investigate(call, signal));
    }

    async peerRoster(callerId: string, workspace: string, details: boolean): Promise<readonly PeerRosterEntry[]> {
        const rosters = await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.peerRoster(callerId, workspace, details)));
        return rosters.flat().sort((left, right) => left.participant_id.localeCompare(right.participant_id));
    }

    async peerSend(caller: PeerCaller, effect: AgentSendEffect): Promise<ToolOutput> {
        return this.relatedOperation(caller.id, effect.to, (endpoint) => endpoint.peerSend(caller, effect));
    }

    private async relatedOperation<T>(callerId: string, targetId: string, run: (endpoint: SessionEndpoint) => Promise<T>, waitForStore = false): Promise<T> {
        const ids = [...new Set([callerId, targetId])];
        const owner = await this.serial(async () => {
            const assigned = await this.claimOwner(targetId, waitForStore);
            for (const id of ids) this.startOperation(id);
            return assigned;
        });
        try {
            return await run(this.endpoint(owner));
        } finally {
            for (const id of ids) this.finishOperation(id);
        }
    }

    async peerLabel(id: string): Promise<string | undefined> {
        const owner = await this.serial(async () => await this.resolvedOwner(id, false) ?? this.hashOwner(id));
        return this.endpoint(owner).peerLabel(id);
    }

    messageSubagent(parentId: string, effect: MessageSubagentEffect): Promise<ToolOutput> {
        return this.relatedOperation(parentId, effect.subagentId, (endpoint) => endpoint.messageSubagent(parentId, effect));
    }

    async closeSubagent(callerId: string, targetId: string): Promise<CloseAgentOutcome> {
        return this.relatedOperation(callerId, targetId, async (endpoint) => {
            const sessions = await this.allResidents();
            const caller = sessions.find((entry) => entry.session.id === callerId)?.session;
            const target = sessions.find((entry) => entry.session.id === targetId)?.session;
            if (target === undefined || target.closed === true || target.failed === true) return { status: "not_found" };
            if (caller === undefined || caller.closed === true || caller.failed === true
                || !this.descendants(callerId, sessions).some((entry) => entry.session.id === targetId)) {
                return { status: "not_owned" };
            }
            if (target.parentId === callerId) await endpoint.suppressCompletion(targetId, true);
            try {
                const result = await this.closeTree(targetId, undefined, true);
                if (result.status !== "closed" && target.parentId === callerId) await endpoint.suppressCompletion(targetId, false);
                return result;
            } catch (error) {
                if (target.parentId === callerId) await endpoint.suppressCompletion(targetId, false);
                throw error;
            }
        });
    }

    notifyParent(parentId: string, delivery: PendingDelivery): Promise<boolean> {
        return this.relatedOperation(delivery.sourceAgentId, parentId, (endpoint) => endpoint.notifyParent(parentId, delivery));
    }

    deliverCompletion(parentId: string, delivery: PendingDelivery): Promise<ParentDeliveryOutcome> {
        const deliver = () => this.relatedOperation(delivery.sourceAgentId, parentId, async (endpoint) => {
            const resident = await endpoint.resident(parentId);
            const path = resident?.sessionPath ?? (await this.list()).find((row) => row.id === parentId)?.session_path;
            return endpoint.deliverCompletion(parentId, delivery, path);
        }, true);
        return this.options.reserveDelivery?.(parentId, deliver) ?? deliver();
    }

    completionFailure(parentId: string, delivery: PendingDelivery): Promise<void> {
        return this.relatedOperation(delivery.sourceAgentId, parentId, (endpoint) => endpoint.completionFailure(parentId, delivery));
    }

    childApproval(parentId: string, update: ToolApprovalUiRequestUpdate, childId: string, task: string): Promise<"allow_once" | "deny"> {
        return this.relatedOperation(childId, parentId, (endpoint) => endpoint.childApproval(parentId, update, childId, task));
    }

    async parentClosing(parentId: string): Promise<boolean> {
        return this.closing.has(parentId);
    }

    reserveSubagentStart(parentId: string, limit: number): Promise<boolean> {
        return this.serial(async () => {
            const counts = await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.runningSubagents(parentId)));
            const starting = this.subagentStarts.get(parentId) ?? 0;
            if (counts.reduce((sum, count) => sum + count, starting) >= limit) return false;
            if (starting === 0) {
                const completion = Promise.withResolvers<void>();
                this.subagentStartCompletions.set(parentId, { promise: completion.promise, resolve: completion.resolve });
            }
            this.subagentStarts.set(parentId, starting + 1);
            return true;
        });
    }

    releaseSubagentStart(parentId: string): Promise<void> {
        return this.serial(() => {
            const remaining = (this.subagentStarts.get(parentId) ?? 1) - 1;
            if (remaining === 0) {
                this.subagentStarts.delete(parentId);
                this.subagentStartCompletions.get(parentId)?.resolve();
                this.subagentStartCompletions.delete(parentId);
            }
            else this.subagentStarts.set(parentId, remaining);
        });
    }

    async beginMasterCreate(
        id: string, path?: string, parentId?: string, owner: SessionOwner = "host", signal?: AbortSignal,
    ): Promise<void> {
        while (true) {
            signal?.throwIfAborted();
            const canonical = path === undefined ? undefined : await this.options.master.canonicalPath(path);
            const waiting = await this.serial(async (): Promise<WaitForOperation | undefined> => {
                signal?.throwIfAborted();
                if (this.trashing.has(id)) throw new UserFacingError("This conversation is being moved to the trash.");
                const pathOwner = canonical === undefined ? undefined : this.masterOpeningPaths.get(canonical);
                const existing = this.operationCompletions.get(pathOwner ?? id);
                if (existing !== undefined) {
                    const recorded = this.owners.get(pathOwner ?? id);
                    if (recorded !== undefined && recorded !== "host" && !this.worker(recorded).ready()) {
                        throw new UserFacingError("The session worker is unavailable.");
                    }
                    return { wait: existing.promise };
                }
                const recorded = this.owners.get(id);
                if (this.options.keepResidentOwner === true && recorded !== undefined && recorded !== owner) {
                    if (recorded !== "host" && !this.worker(recorded).ready()) {
                        throw new UserFacingError("The session worker is unavailable.");
                    }
                    throw new Error(`Resident agent ${id} already exists`);
                }
                if ((await this.allResidents()).some((entry) => entry.session.id === id)) {
                    throw new Error(`Resident agent ${id} already exists`);
                }
                signal?.throwIfAborted();
                const current = this.owners.get(id);
                if (this.options.keepResidentOwner === true && current !== undefined && current !== owner) {
                    if (current !== "host" && !this.worker(current).ready()) {
                        throw new UserFacingError("The session worker is unavailable.");
                    }
                    throw new Error(`Resident agent ${id} already exists`);
                }
                if (owner !== "host" && !this.worker(owner).ready()) {
                    throw new UserFacingError("The session worker is unavailable.");
                }
                const opening = owner === "host" ? undefined : await this.beginRecoveryOpen(owner, id, canonical);
                if (signal?.aborted) {
                    this.finishRecoveryOpen(id, opening);
                    signal.throwIfAborted();
                }
                this.startOperation(id);
                this.masterOpening.add(id);
                if (this.options.keepResidentOwner === true || owner !== "host") this.owners.set(id, owner);
                if (owner !== "host") {
                    this.workerOpenings.set(id, owner);
                }
                if (parentId !== undefined) this.masterOpeningParents.set(id, parentId);
                if (canonical !== undefined) {
                    this.masterOpeningPaths.set(canonical, id);
                    this.paths.set(id, canonical);
                }
                return undefined;
            });
            if (waiting === undefined) return;
            await waiting.wait;
        }
    }

    async beginMasterResume(path: string): Promise<string> {
        const residents = await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.residentAt(path)));
        const resident = residents.find((entry) => entry !== undefined);
        if (resident !== undefined) throw new Error(`Resident agent ${resident.id} already exists`);
        const inspected = await this.options.worker.inspect(path);
        await this.beginMasterCreate(inspected.id, inspected.sessionPath);
        return inspected.id;
    }

    async beginWorkerCreate(owner: WorkerOwner, id: string, path?: string, parentId?: string, signal?: AbortSignal): Promise<void> {
        await this.beginMasterCreate(id, path, parentId, owner, signal);
    }

    endWorkerOpen(id: string): void {
        const owner = this.workerOpenings.get(id);
        const opening = this.recoveryOpens.get(id);
        if (opening?.owner === owner) this.finishRecoveryOpen(id, opening);
        this.workerOpenings.delete(id);
        this.endMasterOpen(id);
    }

    workerExited(owner: WorkerOwner): void {
        for (const [id, current] of this.owners) {
            if (current === owner && this.options.keepResidentOwner !== true) this.owners.delete(id);
            if (current === owner) this.residents.delete(id);
        }
        for (const [id, opening] of this.recoveryOpens) if (opening.owner === owner) this.recoveryOpens.delete(id);
        for (const [id, worker] of this.workerOpenings) {
            if (worker === owner) this.endWorkerOpen(id);
        }
    }

    endMasterOpen(id: string): void {
        this.masterOpening.delete(id);
        this.masterOpeningParents.delete(id);
        for (const [path, owner] of this.masterOpeningPaths) {
            if (owner === id) this.masterOpeningPaths.delete(path);
        }
        this.finishOperation(id);
    }

    rename(id: string, name: string | null, reserved = false): Promise<RenameSessionOutcome> {
        return this.serial(async () => this.endpoint(await this.claimOwner(id)).rename(id, name, reserved));
    }

    async trash(id: string, reserved = false): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        const prepared = await this.serial(async (): Promise<PreparedTrash | StoredTrash | "busy"> => {
            if (this.trashing.has(id)) return "busy";
            const recorded = this.owners.get(id);
            if (recorded !== undefined && recorded !== "host" && !this.worker(recorded).ready()) {
                throw new UserFacingError("The session worker is unavailable.");
            }
            const residents = await this.allResidents();
            const root = residents.find((entry) => entry.session.id === id);
            if (this.options.keepResidentOwner === true && recorded !== undefined && root !== undefined && root.owner !== recorded) {
                throw new Error("Session ownership conflicts with its resident host");
            }
            if (root === undefined || root.session.closed === true || root.session.failed === true) {
                const storedOwner = await this.claimOwner(id);
                this.trashing.add(id);
                this.startOperation(id);
                this.closing.set(id, (this.closing.get(id) ?? 0) + 1);
                return { storedOwner };
            }
            const members = [root, ...this.descendants(id, residents)];
            const ids = members.map((entry) => entry.session.id);
            if (ids.some((memberId) => this.trashing.has(memberId))) return "busy";
            const registered = residents.map((entry) => entry.session.id);
            for (const memberId of ids) {
                this.trashing.add(memberId);
                this.startOperation(memberId);
                this.closing.set(memberId, (this.closing.get(memberId) ?? 0) + 1);
            }
            try {
                const endpoints = [...this.endpoints.entries()];
                const results = await Promise.allSettled(endpoints.map(([owner, endpoint]) =>
                    endpoint.reserveTrash(members.filter((entry) => entry.owner === owner).map((entry) => entry.session.id), id, registered, ids)
                ));
                if (results.every((result) => result.status === "fulfilled" && result.value.status === "reserved")) {
                    return { root, members, residents, plans: results.flatMap((result) =>
                        result.status === "fulfilled" && result.value.status === "reserved" ? result.value.plans : []
                    ) };
                }
                await Promise.allSettled(results.flatMap((result, index) =>
                    result.status === "fulfilled" && result.value.status === "reserved" ? [endpoints[index]![1].releaseTrash(ids)] : []
                ));
                this.finishTrash(ids);
                const failure = results.find((result) => result.status === "rejected");
                if (failure?.status === "rejected") throw failure.reason;
                return "busy";
            } catch (error) {
                if (this.trashing.has(id)) this.finishTrash(ids);
                throw error;
            }
        });
        if (typeof prepared === "string") return prepared;
        if ("storedOwner" in prepared) {
            try {
                const outcome = await this.endpoint(prepared.storedOwner).trash(id, reserved);
                if (outcome === "trashed") {
                    await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.forgetStored(id)));
                }
                return outcome;
            } finally {
                this.finishTrash([id]);
            }
        }
        const reservedIds = prepared.members.map((entry) => entry.session.id);
        try {
            return await trashAcrossOwners(
                this.endpoints, prepared, (parentId) => this.closing.has(parentId),
                () => this.serial(async () => {
                    const current = await this.allResidents();
                    const known = new Set(prepared.members.map((entry) => entry.session.id));
                    const graph = [...prepared.members, ...current.filter((entry) => !known.has(entry.session.id))];
                    const added = this.descendants(id, graph).filter((entry) => !known.has(entry.session.id));
                    for (const member of added) {
                        const memberId = member.session.id;
                        this.trashing.add(memberId);
                        this.startOperation(memberId);
                        this.closing.set(memberId, (this.closing.get(memberId) ?? 0) + 1);
                    }
                    return added;
                }),
            );
        } finally {
            await Promise.allSettled([...this.endpoints.values()].map((endpoint) => endpoint.releaseTrash(reservedIds)));
            this.finishTrash(prepared.members.map((entry) => entry.session.id));
        }
    }

    private finishTrash(ids: readonly string[]): void {
        for (const id of ids) {
            this.trashing.delete(id);
            const count = this.closing.get(id)! - 1;
            if (count === 0) this.closing.delete(id);
            else this.closing.set(id, count);
            this.finishOperation(id);
        }
    }

    close(id: string, reason?: SessionEndReason): Promise<CloseAgentOutcome> {
        return this.closeTree(id, reason, false);
    }

    private async closeTree(id: string, reason: SessionEndReason | undefined, residentOnly: boolean): Promise<CloseAgentOutcome> {
        const prepared = await this.serial(async () => {
            if (this.trashing.has(id)) return { busy: true as const };
            const recorded = this.owners.get(id);
            if (recorded !== undefined && recorded !== "host" && !this.worker(recorded).ready()) {
                throw new UserFacingError("The session worker is unavailable.");
            }
            const sessions = await this.allResidents();
            const root = sessions.find((entry) => entry.session.id === id);
            if (this.options.keepResidentOwner === true && recorded !== undefined && root !== undefined && root.owner !== recorded) {
                throw new Error("Session ownership conflicts with its resident host");
            }
            if (residentOnly && (root === undefined || root.session.closed === true || root.session.failed === true)) return { missing: true as const };
            if (root !== undefined && !(await this.endpoint(root.owner).canClose(id))) return { busy: true as const };
            const members = root === undefined ? [] : [root, ...this.descendants(id, sessions)];
            for (const member of members) {
                const memberId = member.session.id;
                this.startOperation(memberId);
                this.closing.set(memberId, (this.closing.get(memberId) ?? 0) + 1);
            }
            const storedOwner = root === undefined ? await this.claimOwner(id) : undefined;
            return { members, root, storedOwner };
        });
        if ("busy" in prepared) return { status: "busy" };
        if ("missing" in prepared) return { status: "not_found" };
        const { root } = prepared;
        if (root === undefined) return this.endpoint(prepared.storedOwner ?? this.hashOwner(id)).close(id, reason);
        const members = [...prepared.members];
        try {
            return await closeAcrossOwners(
                this.endpoints, root, members, reason ?? "closed",
                () => this.serial(async () => {
                    const current = await this.allResidents();
                    const known = new Set(members.map((member) => member.session.id));
                    const added = this.descendants(id, current).filter((member) => !known.has(member.session.id));
                    for (const member of added) {
                        const memberId = member.session.id;
                        this.startOperation(memberId);
                        this.closing.set(memberId, (this.closing.get(memberId) ?? 0) + 1);
                    }
                    return added;
                }),
            );
        } finally {
            for (const member of members) {
                const memberId = member.session.id;
                const count = this.closing.get(memberId) ?? 0;
                if (count <= 1) this.closing.delete(memberId);
                else this.closing.set(memberId, count - 1);
                this.finishOperation(memberId);
            }
        }
    }

    block(request: BlockSessionRequest): Promise<BlockSessionOutcome> {
        return this.withResidents((sessions) => blockAcrossOwners(
            this.endpoints, this.workers[0]!.id, sessions, request,
            () => this.allResidents(), (ids) => this.waitForSubagentStarts(ids),
        ));
    }

    private async waitForSubagentStarts(ids: readonly string[]): Promise<void> {
        while (true) {
            const pending = await this.serial(() => {
                const parents = new Set(ids);
                return [
                    ...ids.flatMap((id) => {
                        const completion = this.subagentStartCompletions.get(id);
                        return completion === undefined ? [] : [completion.promise];
                    }),
                    ...[...this.masterOpeningParents].flatMap(([id, parent]) => {
                        const completion = this.operationCompletions.get(id);
                        return parents.has(parent) && completion !== undefined ? [completion.promise] : [];
                    }),
                ];
            });
            if (pending.length === 0) return;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.all(pending),
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error("Session block timed out waiting for a child to start.")), 5_000);
                    }),
                ]);
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        }
    }

    unblock(request: UnblockSessionRequest): Promise<UnblockSessionOutcome> {
        return this.withResidents(() => unblockAcrossOwners(this.endpoints, this.workers[0]!.id, request));
    }

    sync(id: string): Promise<BranchSyncOutcome> {
        return this.extensionOperation(id, async (target) => {
            const info = await target.branchSyncInfo(id);
            if (info?.sourceId === undefined) return { status: "not_found", turns: 0 };
            return this.extensionOperation(info.sourceId, async (source) => {
                if (source === target) return target.sync(id);
                const ready = await source.branchSourceReady(info.sourceId!);
                if (ready === undefined) return { status: "not_found", turns: 0 };
                if (!ready || !info.ready) return { status: "busy", turns: 0 };
                const delta = await source.branchSyncDelta(info.sourceId!, info.cursor);
                return delta.status === "ready"
                    ? target.applyBranchSync(id, delta)
                    : { status: delta.status, turns: 0 };
            });
        });
    }

    async facts(sessions: readonly RegisteredAgentSummary[], include: readonly SessionFactName[]): Promise<readonly RegisteredAgentSummary[]> {
        const assigned = await this.serial(async () => {
            const assigned = new Map<SessionOwner, RegisteredAgentSummary[]>();
            for (const session of sessions) {
                const owner = await this.resolvedOwner(session.id) ?? this.hashOwner(session.id);
                const rows = assigned.get(owner) ?? [];
                rows.push(session);
                assigned.set(owner, rows);
            }
            for (const session of sessions) this.startOperation(session.id);
            return assigned;
        });
        try {
            const result = await Promise.all([...assigned.entries()].map(([owner, rows]) => this.endpoint(owner).facts(rows, include)));
            const rows = new Map(result.flat().map((row) => [row.id, row]));
            return sessions.map((session) => rows.get(session.id) ?? session);
        } finally {
            for (const session of sessions) this.finishOperation(session.id);
        }
    }

    async search(query: SessionSearchQuery): Promise<SessionSearchResults> {
        if (this.workers.some((worker) => !worker.ready())) throw new UserFacingError("The session worker is unavailable.");
        const scan = await this.serial(async () => {
            const owners = [...this.endpoints.entries()];
            const [rosters, residents] = await Promise.all([
                Promise.all(owners.map(([, endpoint]) => endpoint.list())),
                this.allResidents(),
            ]);
            const paths = new Map<SessionOwner, string[]>(owners.map(([owner]) => [owner, []]));
            const seen = new Set<string>();
            for (const rows of rosters) {
                for (const row of rows) {
                    if (seen.has(row.id)) continue;
                    seen.add(row.id);
                    const owner = await this.resolvedOwner(row.id) ?? this.hashOwner(row.id);
                    paths.get(owner)?.push(row.session_path);
                }
            }
            for (const entry of residents) this.startOperation(entry.session.id);
            return { paths, residents };
        });
        try {
            return await searchAcrossOwners(this.endpoints, scan.paths, query);
        } finally {
            for (const entry of scan.residents) this.finishOperation(entry.session.id);
        }
    }

    async flush(): Promise<void> {
        await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.flush()));
    }

    cut(id: string, reason: string): Promise<boolean> {
        return this.extensionOperation(id, (endpoint) => endpoint.cut(id, reason));
    }

    async stopWaitTargets(): Promise<readonly StopWaitTarget[]> {
        return (await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.stopWaitTargets()))).flat();
    }

    async parkIdle(now = Date.now()): Promise<void> {
        const facts = (await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.parkFacts()))).flat();
        const byId = new Map(facts.map((entry) => [entry.id, entry]));
        const expired: string[] = [];
        for (const entry of facts) {
            if (entry.starting || (entry.parentId !== undefined && byId.has(entry.parentId))) continue;
            const members = [entry];
            const seen = new Set([entry.id]);
            for (let index = 0; index < members.length; index += 1) {
                const parent = members[index]!;
                for (const candidate of facts) {
                    if (candidate.parentId !== parent.id || seen.has(candidate.id)) continue;
                    seen.add(candidate.id);
                    members.push(candidate);
                }
            }
            if (members.some((member) => !member.idle)) continue;
            const latest = Math.max(...members.map((member) => Date.parse(member.updatedAt)).filter(Number.isFinite));
            if (Number.isFinite(latest) && now - latest >= LIVE_IDLE_WINDOW_MS) expired.push(entry.id);
        }
        for (const id of expired) await this.close(id, "idle").catch(() => {});
    }

    async waitForImports(): Promise<void> {
        await this.imports;
    }

    importSession(path: string): Promise<SessionImportOutcome> {
        const run = this.imports.then(async () => {
            if (this.workers.some((worker) => !worker.ready())) throw new UserFacingError("The session worker is unavailable.");
            await this.shareImportIndex();
            let id = randomUUID();
            while (this.owners.has(id) || this.masterOpening.has(id)) id = randomUUID();
            this.owners.set(id, "w0");
            const outcome = await this.options.worker.importSession(path, id);
            if (outcome.status !== "imported" || outcome.existing) {
                if (this.owners.get(id) === "w0") this.owners.delete(id);
            } else if (outcome.sessionId !== id) {
                throw new Error("Session worker returned a different id");
            }
            return outcome;
        });
        this.imports = run.then(() => undefined, () => undefined);
        return run;
    }

    async listImportableSessions(workspace: string | undefined): Promise<ImportableSessionListing> {
        await this.waitForImports();
        if (this.workers.some((worker) => !worker.ready())) throw new UserFacingError("The session worker is unavailable.");
        await this.shareImportIndex();
        return await this.options.worker.listImportableSessions(workspace);
    }

    private async shareImportIndex(): Promise<void> {
        const rosters = await Promise.all([...this.endpoints.values()].map((endpoint) => endpoint.list()));
        const rows = mergeRosters([...this.endpoints.keys()].map((owner, index) => [owner, rosters[index]!] as const),
            (id) => this.owners.get(id));
        await Promise.all(rows.map((row) => this.options.worker.rememberStored(row)));
    }

    importedSourceHash(summary: RegisteredAgentSummary): Promise<string | undefined> {
        return this.extensionOperation(summary.id, (endpoint) => endpoint.importedSourceHash(summary.id, summary.session_path), true);
    }

    pumpInbox(from: SessionOwner, admittedSeq?: number): Promise<void> {
        return from === "host" ? Promise.resolve() : this.options.master.pumpInbox(admittedSeq);
    }

    list(): Promise<RegisteredAgentSummary[]> {
        return this.serial(async () => {
            const owners = this.activeEndpoints();
            const [rosters, residents] = await Promise.all([
                Promise.all(owners.map(([, endpoint]) => endpoint.list())),
                this.allResidents(),
            ]);
            const residentOwners = new Map<string, SessionOwner>();
            for (const entry of residents) {
                if (residentOwners.has(entry.session.id)) throw new Error("Session is resident on multiple hosts");
                residentOwners.set(entry.session.id, entry.owner);
            }
            return mergeRosters(owners.map(([owner], index) => [owner, rosters[index]!] as const),
                (id) => residentOwners.get(id) ?? this.owners.get(id));
        });
    }

    private endpoint(owner: SessionOwner): SessionEndpoint {
        if (owner !== "host" && !this.worker(owner).ready()) throw new UserFacingError("The session worker is unavailable.");
        const endpoint = this.endpoints.get(owner);
        if (endpoint === undefined) throw new Error("Unknown session owner");
        return endpoint;
    }

    private worker(owner: WorkerOwner): RouterWorker {
        const worker = this.workers.find((candidate) => candidate.id === owner);
        if (worker === undefined) throw new Error("Unknown session worker");
        return worker;
    }

    private hashOwner(id: string): WorkerOwner {
        return this.workers[sessionShardIndex(id, this.workers.length)]!.id;
    }

    inboxOwner(id: string): SessionOwner {
        return this.owners.get(id) ?? this.hashOwner(id);
    }

    private activeEndpoints(): Array<[SessionOwner, SessionEndpoint]> {
        return [["host", this.options.master], ...this.workers.filter((worker) => worker.ready())
            .map((worker): [SessionOwner, SessionEndpoint] => [worker.id, worker.endpoint])];
    }

    private async withResidents<T>(run: (sessions: readonly OwnedSession[]) => Promise<T>): Promise<T> {
        const sessions = await this.serial(async () => {
            const current = await this.allResidents();
            for (const entry of current) this.startOperation(entry.session.id);
            return current;
        });
        try {
            return await run(sessions);
        } finally {
            for (const entry of sessions) this.finishOperation(entry.session.id);
        }
    }

    private async allResidents(): Promise<readonly OwnedSession[]> {
        const endpoints = this.activeEndpoints();
        const residents = await Promise.all(endpoints.map(([, endpoint]) => endpoint.residents()));
        return residents.flatMap((sessions, index) => sessions.map((session) => ({ owner: endpoints[index]![0], session })));
    }

    async attachmentTree(): Promise<AttachmentTreeReader> {
        const sessions = await this.allResidents();
        return (id) => [id, ...this.descendants(id, sessions).map((entry) => entry.session.id)];
    }

    private descendants(id: string, sessions: readonly OwnedSession[]): OwnedSession[] {
        const result: OwnedSession[] = [];
        const seen = new Set([id]);
        const visit = (parentId: string): void => {
            for (const entry of sessions) {
                if (entry.session.parentId !== parentId || seen.has(entry.session.id)) continue;
                seen.add(entry.session.id);
                visit(entry.session.id);
                result.push(entry);
            }
        };
        visit(id);
        return result;
    }

    private async extensionOperation<T>(id: string, run: (endpoint: SessionEndpoint) => Promise<T>, waitForStore = false): Promise<T> {
        const owner = await this.serial(async () => {
            const assigned = await this.claimOwner(id, waitForStore);
            this.startOperation(id);
            return assigned;
        });
        try {
            return await run(this.endpoint(owner));
        } finally {
            this.finishOperation(id);
        }
    }

    private finishOperation(id: string): void {
        const count = this.extensionOperations.get(id);
        if (count === undefined || count <= 1) {
            this.extensionOperations.delete(id);
            const completion = this.operationCompletions.get(id);
            this.operationCompletions.delete(id);
            completion?.resolve();
        } else this.extensionOperations.set(id, count - 1);
    }

    private startOperation(id: string): void {
        if (!this.extensionOperations.has(id)) {
            const completion = Promise.withResolvers<void>();
            this.operationCompletions.set(id, { promise: completion.promise, resolve: completion.resolve });
        }
        this.extensionOperations.set(id, (this.extensionOperations.get(id) ?? 0) + 1);
    }

    private async owner(id: string, waitForStore: boolean): Promise<SessionOwner | undefined> {
        if (waitForStore && this.trashing.has(id)) throw new UserFacingError("This conversation is being moved to the trash.");
        if (waitForStore && this.masterOpening.has(id)) this.waitForOpen(id);
        const recorded = this.owners.get(id);
        if (this.options.keepResidentOwner === true && recorded !== undefined) return recorded;
        const residents = (await this.allResidents()).filter((entry) => entry.session.id === id);
        if (residents.length > 1) throw new Error("Session is resident on multiple hosts");
        if (residents[0] !== undefined) return residents[0].owner;
        const pending = this.operationCompletions.get(id);
        if (waitForStore && pending !== undefined) throw new OwnershipPending(pending.promise);
        const previous = this.owners.get(id);
        if (previous === "host") this.owners.delete(id);
        if (previous !== undefined && previous !== "host") return previous;
        const stored = (await this.options.master.list()).find((summary) => summary.id === id && !summary.live);
        if (stored !== undefined) {
            const owner = this.hashOwner(id);
            await this.endpoint(owner).rememberStored(stored);
            this.owners.set(id, owner);
            return owner;
        }
        return undefined;
    }

    private async resolvedOwner(id: string, waitForStore = true): Promise<SessionOwner | undefined> {
        return await this.owner(id, waitForStore);
    }

    private async claimOwner(id: string, waitForStore = true): Promise<SessionOwner> {
        const owner = await this.resolvedOwner(id, waitForStore) ?? this.hashOwner(id);
        if (owner !== "host" && !this.worker(owner).ready()) throw new UserFacingError("The session worker is unavailable.");
        if (!this.owners.has(id)) this.owners.set(id, owner);
        return owner;
    }

    private waitForOpen(id: string): never {
        const owner = this.owners.get(id);
        if (owner !== undefined && owner !== "host" && !this.worker(owner).ready()) {
            throw new UserFacingError("The session worker is unavailable.");
        }
        throw new OwnershipPending(this.operationCompletions.get(id)!.promise);
    }

    private serial<T>(run: () => T | Promise<T>): Promise<T> {
        const result = this.pending.then(run);
        this.pending = result.then(() => undefined, () => undefined);
        return result.catch(async (error: unknown) => {
            if (!(error instanceof OwnershipPending)) throw error;
            await error.wait;
            return this.serial(run);
        });
    }
}
