import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { readSessionHeader } from "../../store/session-store.ts";
import type { SessionEndpoint, RoutedSession } from "../pool/router.ts";
import type { SessionHost } from "./types.ts";
import { applyBranchSync, branchSourceReady, branchSyncDelta, branchSyncInfo } from "../agent-registry/context-sync.ts";
import { localMessageSubagent } from "../agent-registry/subagent.ts";
import * as subagentEndpoint from "../agent-registry/subagent-endpoint.ts";
import * as lifecycle from "../agent-registry/lifecycle.ts";
import { entryUpdatedAt, type RegisteredAgentEntry } from "../agent-registry/support.ts";

export function sessionEndpoint(host: SessionHost): SessionEndpoint {
    const closing = new Map<string, RegisteredAgentEntry>();
    const resident = (id: string): RoutedSession | undefined => {
        const entry = host.registry.agents.get(id);
        return entry === undefined ? undefined : {
            id,
            workspace: entry.agent.workspace,
            sessionPath: entry.store.path,
            ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
            ...(entry.agent.closed ? { closed: true } : {}),
            ...(entry.agent.failed || entry.failure !== undefined ? { failed: true } : {}),
            ...(entry.ephemeral ? { ephemeral: true } : {}),
        };
    };
    const describe = (id: string): RoutedSession => {
        const session = resident(id);
        if (session === undefined) throw new Error("Session is not resident");
        return session;
    };
    const tree = (id: string): readonly string[] => {
        let root = id;
        const seen = new Set<string>();
        while (!seen.has(root)) {
            seen.add(root);
            const parent = host.registry.agents.get(root)?.parentId;
            if (parent === undefined || !host.registry.agents.has(parent)) break;
            root = parent;
        }
        return host.registry.ownedTreeIds(root);
    };
    return {
        canonicalPath,
        setSessionTitle: (id, title) => host.localExtensionSessions.setSessionTitle(id, title),
        sendToSession: (extensionId, id, text) => host.localExtensionSessions.sendToSession(extensionId, id, text),
        askSession: (call, signal) => host.localExtensionSessions.askSession(call, signal),
        investigate: (call, signal) => host.localExtensionSessions.investigate(call, signal),
        peerRoster: async (callerId, workspace, details) => host.registry.localPeerRoster(callerId, workspace, details),
        peerSend: (caller, effect) => host.registry.sendToPeer(caller, effect),
        peerLabel: async (id) => host.registry.localPeerLabel(id),
        messageSubagent: (parentId, effect) => localMessageSubagent(host.registry, parentId, effect),
        notifyParent: (parentId, delivery) => subagentEndpoint.notifyParent(host.registry, parentId, delivery),
        deliverCompletion: (parentId, delivery, parentPath) => subagentEndpoint.deliverCompletion(host.registry, parentId, delivery, parentPath),
        completionFailure: (parentId, delivery) => subagentEndpoint.completionFailure(host.registry, parentId, delivery),
        childApproval: (parentId, update, childId, task) => subagentEndpoint.childApproval(host.registry, parentId, update, childId, task),
        closeSubagent: async (callerId, targetId) => {
            const result = await host.registry.closeDescendantTree(callerId, targetId);
            return { status: result.status, sessionRetained: result.sessionRetained };
        },
        parentClosing: async (id) => {
            const entry = host.registry.agents.get(id);
            return entry !== undefined && host.registry.closingCompletionRecipients.has(entry.store);
        },
        async inspect(path) {
            const sessionPath = await realpath(path);
            const header = await readSessionHeader(sessionPath);
            const parentId = header.delegation?.parentId ?? header.parentId;
            return { id: header.id, sessionPath, ...(parentId === undefined ? {} : { parentId }) };
        },
        async residentAt(path) {
            const canonical = await realpath(path);
            for (const id of host.registry.agents.keys()) {
                const session = resident(id);
                if (session !== undefined && await realpath(session.sessionPath).catch(() => session.sessionPath) === canonical) return session;
            }
            return undefined;
        },
        resident: async (id) => resident(id),
        residents: async () => [...host.registry.agents.keys()].flatMap((id) => {
            const session = resident(id);
            return session === undefined ? [] : [session];
        }),
        tree: async (id) => tree(id),
        async find(id, reserved) {
            const agent = reserved
                ? await host.handlers.findAgentReserved(id)
                : await host.handlers.findAgent(id);
            return agent === undefined || agent.closed ? undefined : describe(agent.id);
        },
        async create(options) {
            const agent = await host.registry.create(options);
            return describe(agent.id);
        },
        async resume(path, options) {
            const agent = options?.reserved
                ? await host.handlers.resumeAgentReserved(path, options.ownershipTransfer)
                : await host.handlers.resumeAgent(path, options?.ownershipTransfer);
            return describe(agent.id);
        },
        async release(id) {
            if (host.registry.deliveryTasks.size > 0) {
                return undefined;
            }
            const members = tree(id);
            const stores = [];
            for (const member of members) {
                const entry = host.registry.agents.get(member);
                if (entry === undefined || entry.ephemeral || entry.pendingPublication
                    || entry.pendingAsyncTurns > 0 || entry.pendingCompletionDeliveries > 0
                    || host.registry.startingIds.has(member) || host.registry.trashingIds.has(member)
                    || !entry.agent.idleForShutdown()) {
                    return undefined;
                }
                stores.push(entry.store);
            }
            const result = await host.handlers.releaseAgent(members[0] ?? id);
            if (result.status !== "closed" && result.status !== "not_found") {
                throw new Error("Session could not be released");
            }
            await Promise.all(stores.map((store) => store.exclusively(async () => {})));
            return members;
        },
        async list() {
            return await host.handlers.listAgents();
        },
        rememberStored: async (summary) => host.handlers.rememberStored(summary),
        forgetStored: async (id) => host.handlers.forgetStored(id),
        rename: (id, name, reserved) => reserved
            ? host.handlers.renameSessionReserved(id, name)
            : host.handlers.renameSession(id, name),
        trash: (id, reserved) => reserved
            ? host.handlers.trashSessionReserved(id)
            : host.handlers.trashSession(id),
        reserveTrash: async (ids, rootId, registeredIds, reservedIds) => lifecycle.reserveDistributedTrash(host.registry, ids, rootId, registeredIds, reservedIds),
        async quiesceClose(ids) {
            return ids.flatMap((id) => {
                const entry = host.registry.agents.get(id);
                if (entry === undefined) return [];
                const token = randomUUID();
                closing.set(token, entry);
                host.registry.closingCompletionRecipients.add(entry.store);
                entry.agent.close();
                return [{ id, token }];
            });
        },
        async waitClose(tickets) {
            for (const ticket of tickets) await closing.get(ticket.token)?.run;
        },
        async finishCloseMember(ticket, reason) {
            const entry = closing.get(ticket.token);
            if (entry === undefined) return undefined;
            closing.delete(ticket.token);
            return lifecycle.finishDistributedCloseMember(host.registry, ticket.id, entry, reason);
        },
        async forgetClose(tickets) {
            for (const ticket of tickets) closing.delete(ticket.token);
        },
        canClose: async (id) => !host.registry.trashingIds.has(id),
        recordClosedMembers: (closed) => host.handlers.recordClosedMembers(closed),
        async moveTrashArtifact(plan) {
            try {
                await host.registry.trashArtifacts({
                    sessionPath: plan.sessionPath,
                    attachmentsPath: `${plan.sessionPath}.attachments`,
                    eventLogPath: plan.eventLogPath,
                });
                return true;
            } catch {
                return false;
            }
        },
        restartTrashMember: (plan) => lifecycle.restartDistributedTrashMember(host.registry, plan),
        abandonTrashRestart: (id) => lifecycle.abandonDistributedTrashRestart(host.registry, id),
        recordTrashOutcome: (rootId, closed, trashed) => host.handlers.recordTrashOutcome(rootId, closed, trashed),
        releaseTrash: async (ids) => lifecycle.releaseDistributedTrash(host.registry, ids),
        close: (id, reason) => host.handlers.closeAgent(id, reason),
        block: (request) => host.handlers.blockSession(request),
        unblock: (request) => host.handlers.unblockSession(request),
        sync: (id) => host.handlers.syncAgentContext(id),
        branchSyncInfo: async (id) => branchSyncInfo(host.registry, id),
        branchSourceReady: async (id) => branchSourceReady(host.registry, id),
        branchSyncDelta: (id, cursor) => branchSyncDelta(host.registry, id, cursor),
        applyBranchSync: (id, delta) => applyBranchSync(host.registry, id, delta),
        facts: (sessions, include) => host.handlers.readSessionFacts(sessions, include),
        search: (query) => host.handlers.searchSessions(query),
        searchShard: (query, includePaths, excludePaths) => host.handlers.searchShard(query, includePaths, excludePaths),
        async flush() {
            await Promise.all([...host.registry.agents.values()].map((entry) => entry.store.exclusively(async () => {})));
        },
        pumpInbox: (admittedSeq) => host.inboxDelivery.pumpLocal(admittedSeq),
        async snapshot() {
            return {
                residents: [...host.registry.agents.keys()].flatMap((id) => {
                    const session = resident(id);
                    return session === undefined ? [] : [session];
                }),
                summaries: await host.handlers.listAgents(),
                work: host.registry.workFacts(),
                unreadSources: host.registry.unreadResultSources(),
            };
        },
        workSchedules: async (agents) => host.handlers.workSchedules(agents),
        importSession: (path, sessionId) => host.handlers.importSession(path, sessionId),
        listImportableSessions: (workspace) => host.handlers.listImportableSessions(workspace),
        async importedSourceHash(id, path) {
            const entry = host.registry.agents.get(id);
            const header = entry === undefined ? await readSessionHeader(path) : entry.store.header;
            return header.id === id ? header.importedFrom?.sourceSha256 : undefined;
        },
        async suppressCompletion(id, suppress) {
            const entry = host.registry.agents.get(id);
            if (entry === undefined) return;
            if (suppress) host.registry.suppressedCompletionDeliveries.add(entry);
            else host.registry.suppressedCompletionDeliveries.delete(entry);
        },
        cut: (id, reason) => host.registry.cutSessionForStop(id, reason),
        stopWaitTargets: async () => host.registry.stopWaitTargets(),
        runningSubagents: async (parentId) => [...host.registry.agents.values()].filter((entry) =>
            entry.kind === "background" && entry.parentId === parentId && entry.failure === undefined
            && !entry.agent.failed && !entry.agent.closed && entry.pendingAsyncTurns > 0).length,
        parkFacts: async () => [...host.registry.agents.values()].map((entry) => ({
            id: entry.agent.id,
            ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
            idle: entry.agent.idleForShutdown(),
            starting: host.registry.startingIds.has(entry.agent.id),
            updatedAt: entryUpdatedAt(entry),
        })),
        blockHasSession: async (id) => host.handlers.blockParts.hasSession(id),
        blockTreeShard: (include, exclude) => host.handlers.blockParts.treeShard(include, exclude),
        blockAbort: (ids) => host.handlers.blockParts.abort(ids),
        blockConfirm: (ids) => host.handlers.blockParts.confirm(ids),
        blockWrite: (request, ids) => host.handlers.blockParts.write(request, ids),
        blockedIds: (ids) => host.handlers.blockParts.blocked(ids),
        blockRemove: (ids) => host.handlers.blockParts.remove(ids),
        blockRelease: (ids) => host.handlers.blockParts.release(ids),
    };
}

async function canonicalPath(path: string): Promise<string> {
    let current = resolve(path);
    const missing: string[] = [];
    while (true) {
        try {
            return join(await realpath(current), ...missing.toReversed());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const parent = dirname(current);
            if (parent === current) throw error;
            missing.push(basename(current));
            current = parent;
        }
    }
}
