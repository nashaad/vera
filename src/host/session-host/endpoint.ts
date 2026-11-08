import { realpath } from "node:fs/promises";

import { readSessionHeader } from "../../store/session-store.ts";
import type { SessionEndpoint, RoutedSession } from "../master/router.ts";
import type { SessionHost } from "./types.ts";

export function sessionEndpoint(host: SessionHost): SessionEndpoint {
    const resident = (id: string): RoutedSession | undefined => {
        const entry = host.registry.agents.get(id);
        return entry === undefined ? undefined : {
            id,
            workspace: entry.agent.workspace,
            sessionPath: entry.store.path,
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
        setSessionTitle: (id, title) => host.localExtensionSessions.setSessionTitle(id, title),
        sendToSession: (extensionId, id, text) => host.localExtensionSessions.sendToSession(extensionId, id, text),
        askSession: (call, signal) => host.localExtensionSessions.askSession(call, signal),
        investigate: (call, signal) => host.localExtensionSessions.investigate(call, signal),
        async inspect(path) {
            const sessionPath = await realpath(path);
            const header = await readSessionHeader(sessionPath);
            return { id: header.id, sessionPath };
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
            const agent = await host.handlers.createAgent(options);
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
                throw new Error("Session cannot be moved while deliveries are pending");
            }
            const members = tree(id);
            const stores = [];
            for (const member of members) {
                const entry = host.registry.agents.get(member);
                if (entry === undefined || entry.ephemeral || entry.pendingPublication
                    || entry.pendingAsyncTurns > 0 || entry.pendingCompletionDeliveries > 0
                    || host.registry.startingIds.has(member) || host.registry.trashingIds.has(member)
                    || !entry.agent.idleForShutdown()) {
                    throw new Error("Session cannot be moved while active");
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
        rename: (id, name, reserved) => reserved
            ? host.handlers.renameSessionReserved(id, name)
            : host.handlers.renameSession(id, name),
        trash: (id, reserved) => reserved
            ? host.handlers.trashSessionReserved(id)
            : host.handlers.trashSession(id),
        close: (id, reason) => host.handlers.closeAgent(id, reason),
        block: (request) => host.handlers.blockSession(request),
        unblock: (request) => host.handlers.unblockSession(request),
        sync: (id) => host.handlers.syncAgentContext(id),
        facts: (sessions, include) => host.handlers.readSessionFacts(sessions, include),
        search: (query) => host.handlers.searchSessions(query),
    };
}
