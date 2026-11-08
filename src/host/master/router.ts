import { randomUUID } from "node:crypto";

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
import type { PendingDelivery } from "../../store/session-store.ts";
import type { MessageSubagentEffect } from "../../tools/types.ts";
import type { ToolApprovalUiRequestUpdate } from "../../engine/protocol.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import type { AttachmentTreeReader } from "../attachment-coordinator.ts";
import { LIVE_IDLE_WINDOW_MS } from "../agent-registry/support.ts";
import { mergeRoster, type SessionOwner } from "./roster.ts";
import type { OwnedSession, RoutedSession, SessionEndpoint } from "./session-endpoint.ts";
import { blockAcrossOwners, unblockAcrossOwners } from "./block.ts";
import { searchAcrossOwners } from "./search.ts";
import { trashAcrossOwners, type PreparedTrash } from "./trash.ts";
import { closeAcrossOwners } from "./close.ts";
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

export interface HostRouterOptions {
    readonly master: SessionEndpoint;
    readonly worker: SessionEndpoint;
    readonly masterSocket: string;
    readonly workerSocket: string;
    readonly buildId: string;
    readonly reserveDelivery?: (id: string, run: () => Promise<ParentDeliveryOutcome>) => Promise<ParentDeliveryOutcome>;
}

export class HostRouter implements ExtensionSessionServices, PeerSessionServices, SubagentSessionServices, SubagentAdmission {
    private readonly owners = new Map<string, SessionOwner>();
    private readonly branches = new Map<string, number>();
    private readonly extensionOperations = new Map<string, number>();
    private readonly masterOpening = new Set<string>();
    private readonly masterOpeningPaths = new Map<string, string>();
    private readonly closing = new Map<string, number>();
    private readonly trashing = new Set<string>();
    private readonly subagentStarts = new Map<string, number>();
    private readonly subagentStartCompletions = new Map<string, OperationCompletion>();
    private readonly masterOpeningParents = new Map<string, string>();
    private readonly operationCompletions = new Map<string, OperationCompletion>();
    private pending: Promise<void> = Promise.resolve();

    constructor(private readonly options: HostRouterOptions) {}

    observe(owner: SessionOwner, sessions: readonly RoutedSession[]): void {
        for (const session of sessions) {
            const current = this.owners.get(session.id);
            if (current === undefined || current === owner) this.owners.set(session.id, owner);
        }
    }

    create(options: Pick<CreateRegisteredAgentOptions,
        "workspace" | "approvalMode" | "ephemeral" | "startupProfile">): Promise<RoutedSession> {
        return this.serial(async () => {
            let id = randomUUID();
            while (this.masterOpening.has(id) || await this.options.master.resident(id) !== undefined
                || await this.options.worker.resident(id) !== undefined) id = randomUUID();
            const session = await this.options.worker.create({ ...options, id });
            this.owners.set(session.id, "w0");
            return session;
        });
    }

    assertResumeAvailable(id: string, parentId?: string): void {
        if (this.trashing.has(id) || (parentId !== undefined && this.trashing.has(parentId))) {
            throw new UserFacingError("This conversation is being moved to the trash.");
        }
    }

    async resume(path: string, reservedPaths?: ReadonlySet<string>): Promise<RoutedSession> {
        while (true) {
            const result = await this.serial(async (): Promise<RoutedSession | WaitForOperation> => {
                const canonical = await this.options.worker.canonicalPath(path);
                const opening = this.masterOpeningPaths.get(canonical);
                if (opening !== undefined) return { wait: this.operationCompletions.get(opening)!.promise };
                const masterAtPath = await this.options.master.residentAt(canonical);
                const inspected = await (masterAtPath === undefined ? this.options.worker : this.options.master).inspect(canonical);
                if (reservedPaths !== undefined && !reservedPaths.has(inspected.sessionPath)) {
                    throw new SessionTransferReservationsChanged();
                }
                if (this.masterOpening.has(inspected.id)) return { wait: this.operationCompletions.get(inspected.id)!.promise };
                this.assertResumeAvailable(inspected.id, inspected.parentId);
                const [existing, master] = await Promise.all([
                    this.options.worker.resident(inspected.id),
                    this.options.master.resident(inspected.id),
                ]);
                if (existing !== undefined && master !== undefined) {
                    throw new Error("Session is resident on both hosts");
                }
                if (existing !== undefined) {
                    if ((await this.options.worker.inspect(existing.sessionPath)).sessionPath !== inspected.sessionPath) {
                        throw new Error("Session id is already in use");
                    }
                    this.owners.set(inspected.id, "w0");
                    return existing;
                }
                if (master === undefined && this.extensionOperations.has(inspected.id)) {
                    return { wait: this.operationCompletions.get(inspected.id)!.promise };
                }
                let transferred: readonly RoutedSession[] = [];
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
                    for (const id of released) this.owners.set(id, "w0");
                }
                this.owners.set(inspected.id, "w0");
                try {
                    const session = await this.options.worker.resume(inspected.sessionPath, {
                        reserved: reservedPaths !== undefined,
                        ownershipTransfer: master !== undefined,
                    });
                    for (const member of transferred) {
                        if (member.id !== inspected.id) {
                            await this.options.worker.resume(member.sessionPath, {
                                reserved: reservedPaths !== undefined,
                                ownershipTransfer: true,
                            });
                        }
                    }
                    return session;
                } catch (error) {
                    this.owners.delete(inspected.id);
                    throw error;
                }
            });
            if (!("wait" in result)) return result;
            await result.wait;
        }
    }

    locate(id: string, reserved = false): Promise<AgentLocationResponse | AgentLocationFailedResponse> {
        return this.serial(async () => {
            try {
                const owner = await this.resolvedOwner(id) ?? "w0";
                const session = await this.endpoint(owner).find(id, reserved);
                if (session === undefined) {
                    return { type: "agent_location_failed", reason: "not_found", message: "No session with this id is on this host." };
                }
                this.owners.set(id, owner);
                return {
                    type: "agent_location",
                    socket_path: owner === "w0" ? this.options.workerSocket : this.options.masterSocket,
                    worker_id: owner,
                    worker_generation: 1,
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

    find(owner: SessionOwner, id: string, reserved = false): Promise<boolean> {
        return this.serial(async () => {
            const assigned = await this.resolvedOwner(id);
            if (assigned !== undefined && assigned !== owner) return false;
            if (assigned === undefined && owner === "host") return false;
            const session = await this.endpoint(owner).find(id, reserved);
            if (session === undefined) return false;
            this.owners.set(id, owner);
            return true;
        });
    }

    socketFor(from: SessionOwner, id: string): Promise<string | undefined> {
        return this.serial(async () => {
            const owner = await this.resolvedOwner(id) ?? "w0";
            if (owner === from) return undefined;
            return owner === "w0" ? this.options.workerSocket : this.options.masterSocket;
        });
    }

    beginBranch(owner: SessionOwner, id: string): Promise<boolean> {
        return this.serial(async () => {
            if ((await this.resolvedOwner(id, false) ?? "w0") !== owner) return false;
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
        const [master, worker] = await Promise.all([
            this.options.master.peerRoster(callerId, workspace, details),
            this.options.worker.peerRoster(callerId, workspace, details),
        ]);
        return [...master, ...worker].sort((left, right) => left.participant_id.localeCompare(right.participant_id));
    }

    async peerSend(caller: PeerCaller, effect: AgentSendEffect): Promise<ToolOutput> {
        return this.relatedOperation(caller.id, effect.to, (endpoint) => endpoint.peerSend(caller, effect));
    }

    private async relatedOperation<T>(callerId: string, targetId: string, run: (endpoint: SessionEndpoint) => Promise<T>, waitForStore = false): Promise<T> {
        const ids = [...new Set([callerId, targetId])];
        const owner = await this.serial(async () => {
            const assigned = await this.resolvedOwner(targetId, waitForStore) ?? "w0";
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
        const owner = await this.serial(async () => await this.resolvedOwner(id, false) ?? "w0");
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
            const [master, worker] = await Promise.all([
                this.options.master.runningSubagents(parentId), this.options.worker.runningSubagents(parentId),
            ]);
            const starting = this.subagentStarts.get(parentId) ?? 0;
            if (master + worker + starting >= limit) return false;
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

    async beginMasterCreate(id: string, path?: string, parentId?: string): Promise<void> {
        while (true) {
            const canonical = path === undefined ? undefined : await this.options.master.canonicalPath(path);
            const waiting = await this.serial(async (): Promise<WaitForOperation | undefined> => {
                if (this.trashing.has(id)) throw new UserFacingError("This conversation is being moved to the trash.");
                const pathOwner = canonical === undefined ? undefined : this.masterOpeningPaths.get(canonical);
                const existing = this.operationCompletions.get(pathOwner ?? id);
                if (existing !== undefined) return { wait: existing.promise };
                const [master, worker] = await Promise.all([this.options.master.resident(id), this.options.worker.resident(id)]);
                if (master !== undefined || worker !== undefined) throw new Error(`Resident agent ${id} already exists`);
                this.startOperation(id);
                this.masterOpening.add(id);
                if (parentId !== undefined) this.masterOpeningParents.set(id, parentId);
                if (canonical !== undefined) this.masterOpeningPaths.set(canonical, id);
                return undefined;
            });
            if (waiting === undefined) return;
            await waiting.wait;
        }
    }

    async beginMasterResume(path: string): Promise<string> {
        const [master, worker] = await Promise.all([
            this.options.master.residentAt(path), this.options.worker.residentAt(path),
        ]);
        const resident = master ?? worker;
        if (resident !== undefined) throw new Error(`Resident agent ${resident.id} already exists`);
        const inspected = await this.options.worker.inspect(path);
        await this.beginMasterCreate(inspected.id, inspected.sessionPath);
        return inspected.id;
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
        return this.serial(async () => this.endpoint(await this.resolvedOwner(id) ?? "w0").rename(id, name, reserved));
    }

    async trash(id: string, reserved = false): Promise<"trashed" | "busy" | "not_found" | "failed"> {
        const prepared = await this.serial(async (): Promise<PreparedTrash | StoredTrash | "busy"> => {
            if (this.trashing.has(id)) return "busy";
            const residents = await this.allResidents();
            const root = residents.find((entry) => entry.session.id === id);
            if (root === undefined || root.session.closed === true || root.session.failed === true) {
                const storedOwner = await this.resolvedOwner(id) ?? "w0";
                this.trashing.add(id);
                this.startOperation(id);
                this.closing.set(id, (this.closing.get(id) ?? 0) + 1);
                return { storedOwner };
            }
            const members = [root, ...this.descendants(id, residents)];
            const ids = members.map((entry) => entry.session.id);
            if (ids.some((memberId) => this.trashing.has(memberId))) return "busy";
            const registered = residents.map((entry) => entry.session.id);
            const hostIds = members.filter((entry) => entry.owner === "host").map((entry) => entry.session.id);
            const workerIds = members.filter((entry) => entry.owner === "w0").map((entry) => entry.session.id);
            for (const memberId of ids) {
                this.trashing.add(memberId);
                this.startOperation(memberId);
                this.closing.set(memberId, (this.closing.get(memberId) ?? 0) + 1);
            }
            try {
                const results = await Promise.allSettled([
                    this.options.master.reserveTrash(hostIds, id, registered, ids),
                    this.options.worker.reserveTrash(workerIds, id, registered, ids),
                ]);
                const [host, worker] = results;
                if (host.status === "fulfilled" && worker.status === "fulfilled"
                    && host.value.status === "reserved" && worker.value.status === "reserved") {
                    return { root, members, residents, plans: [...host.value.plans, ...worker.value.plans] };
                }
                await Promise.allSettled([
                    ...(host.status === "fulfilled" && host.value.status === "reserved" ? [this.options.master.releaseTrash(ids)] : []),
                    ...(worker.status === "fulfilled" && worker.value.status === "reserved" ? [this.options.worker.releaseTrash(ids)] : []),
                ]);
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
                    await Promise.all([this.options.master.forgetStored(id), this.options.worker.forgetStored(id)]);
                }
                return outcome;
            } finally {
                this.finishTrash([id]);
            }
        }
        const reservedIds = prepared.members.map((entry) => entry.session.id);
        try {
            return await trashAcrossOwners(
                this.options.master, this.options.worker, prepared, (parentId) => this.closing.has(parentId),
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
            await Promise.allSettled([this.options.master.releaseTrash(reservedIds), this.options.worker.releaseTrash(reservedIds)]);
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
            const sessions = await this.allResidents();
            const root = sessions.find((entry) => entry.session.id === id);
            if (residentOnly && (root === undefined || root.session.closed === true || root.session.failed === true)) return { missing: true as const };
            if (root !== undefined && !(await this.endpoint(root.owner).canClose(id))) return { busy: true as const };
            const members = root === undefined ? [] : [root, ...this.descendants(id, sessions)];
            for (const member of members) {
                const memberId = member.session.id;
                this.startOperation(memberId);
                this.closing.set(memberId, (this.closing.get(memberId) ?? 0) + 1);
            }
            const storedOwner = root === undefined ? await this.resolvedOwner(id) ?? "w0" : undefined;
            return { members, root, storedOwner };
        });
        if ("busy" in prepared) return { status: "busy" };
        if ("missing" in prepared) return { status: "not_found" };
        const { root } = prepared;
        if (root === undefined) return this.endpoint(prepared.storedOwner ?? "w0").close(id, reason);
        const members = [...prepared.members];
        try {
            return await closeAcrossOwners(
                this.options.master, this.options.worker, root, members, reason ?? "closed",
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
            this.options.master, this.options.worker, sessions, request,
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
        return this.withResidents((sessions) => unblockAcrossOwners(this.options.master, this.options.worker, sessions, request));
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
        const [master, worker] = await this.serial(async () => {
            const master: RegisteredAgentSummary[] = [];
            const worker: RegisteredAgentSummary[] = [];
            for (const session of sessions) {
                ((await this.resolvedOwner(session.id) ?? "w0") === "w0" ? worker : master).push(session);
            }
            for (const session of sessions) this.startOperation(session.id);
            return [master, worker] as const;
        });
        try {
            const [masterRows, workerRows] = await Promise.all([
                this.options.master.facts(master, include),
                this.options.worker.facts(worker, include),
            ]);
            const rows = new Map([...masterRows, ...workerRows].map((row) => [row.id, row]));
            return sessions.map((session) => rows.get(session.id) ?? session);
        } finally {
            for (const session of sessions) this.finishOperation(session.id);
        }
    }

    async search(query: SessionSearchQuery): Promise<SessionSearchResults> {
        if (query.session_id !== undefined) {
            return await this.extensionOperation(query.session_id, (endpoint) => endpoint.search(query), true);
        }
        const master = await this.serial(async () => {
            const sessions = await this.options.master.residents();
            for (const session of sessions) {
                this.startOperation(session.id);
            }
            return sessions;
        });
        try {
            const paths = master.map((session) => session.sessionPath);
            return await searchAcrossOwners(this.options.master, this.options.worker, paths, query);
        } finally {
            for (const session of master) this.finishOperation(session.id);
        }
    }

    async flush(): Promise<void> {
        await Promise.all([this.options.master.flush(), this.options.worker.flush()]);
    }

    cut(id: string, reason: string): Promise<boolean> {
        return this.extensionOperation(id, (endpoint) => endpoint.cut(id, reason));
    }

    async stopWaitTargets(): Promise<readonly StopWaitTarget[]> {
        const [master, worker] = await Promise.all([this.options.master.stopWaitTargets(), this.options.worker.stopWaitTargets()]);
        return [...master, ...worker];
    }

    async parkIdle(now = Date.now()): Promise<void> {
        const [host, worker] = await Promise.all([this.options.master.parkFacts(), this.options.worker.parkFacts()]);
        const facts = [...host, ...worker];
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

    importSession(path: string): Promise<SessionImportOutcome> {
        return this.options.worker.importSession(path);
    }

    listImportableSessions(workspace: string | undefined): Promise<ImportableSessionListing> {
        return this.options.worker.listImportableSessions(workspace);
    }

    importedSourceHash(summary: RegisteredAgentSummary): Promise<string | undefined> {
        return this.extensionOperation(summary.id, (endpoint) => endpoint.importedSourceHash(summary.id, summary.session_path), true);
    }

    pumpInbox(from: SessionOwner, admittedSeq?: number): Promise<void> {
        return this.endpoint(from === "host" ? "w0" : "host").pumpInbox(admittedSeq);
    }

    list(): Promise<RegisteredAgentSummary[]> {
        return this.serial(async () => {
            const [master, worker, masterResidents, workerResidents] = await Promise.all([
                this.options.master.list(),
                this.options.worker.list(),
                this.options.master.residents(),
                this.options.worker.residents(),
            ]);
            const masterIds = new Set(masterResidents.map((session) => session.id));
            const workerIds = new Set(workerResidents.map((session) => session.id));
            for (const id of masterIds) {
                if (workerIds.has(id)) throw new Error("Session is resident on both hosts");
            }
            return mergeRoster(master, worker, (id) => workerIds.has(id)
                ? "w0"
                : masterIds.has(id) ? "host" : this.owners.get(id));
        });
    }

    private endpoint(owner: SessionOwner): SessionEndpoint {
        return owner === "host" ? this.options.master : this.options.worker;
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
        const [master, worker] = await Promise.all([this.options.master.residents(), this.options.worker.residents()]);
        return [
            ...master.map((session) => ({ owner: "host" as const, session })),
            ...worker.map((session) => ({ owner: "w0" as const, session })),
        ];
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
            const assigned = await this.resolvedOwner(id, waitForStore) ?? "w0";
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
        if (waitForStore && this.masterOpening.has(id)) throw new OwnershipPending(this.operationCompletions.get(id)!.promise);
        const [master, worker] = await Promise.all([
            this.options.master.resident(id), this.options.worker.resident(id),
        ]);
        if (master !== undefined && worker !== undefined) throw new Error("Session is resident on both hosts");
        if (worker !== undefined) return "w0";
        if (master !== undefined) return "host";
        const pending = this.operationCompletions.get(id);
        if (waitForStore && pending !== undefined) throw new OwnershipPending(pending.promise);
        const previous = this.owners.get(id);
        if (previous === "host") this.owners.delete(id);
        if (previous === "w0") return previous;
        const stored = (await this.options.master.list()).find((summary) => summary.id === id && !summary.live);
        if (stored !== undefined) {
            await this.options.worker.rememberStored(stored);
            this.owners.set(id, "w0");
            return "w0";
        }
        return undefined;
    }

    private async resolvedOwner(id: string, waitForStore = true): Promise<SessionOwner | undefined> {
        return await this.owner(id, waitForStore);
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
