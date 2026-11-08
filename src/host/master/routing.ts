import { userFacingMessage } from "../../user-facing-error.ts";
import type { HostRequest } from "../protocol.ts";
import type { StartHostServerOptions } from "../server.ts";
import type { SessionHost } from "../session-host.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import { withSessionReservation, withSessionReservations, type RestoringSessions } from "../session-host/storage.ts";
import { InteractiveAttachmentCoordinator } from "../attachment-coordinator.ts";
import { HostRouter, SessionTransferReservationsChanged } from "./router.ts";
import type { SessionEndpoint } from "./session-endpoint.ts";
import type { SessionOwner } from "./roster.ts";
import { RoutedSnapshots } from "./snapshots.ts";

export interface RoutedHostOptions {
    readonly master: SessionHost;
    readonly worker: SessionEndpoint;
    readonly masterSocket: string;
    readonly workerSocket: string;
    readonly buildId: string;
    readonly reservations: RestoringSessions;
    readonly workerReady: () => boolean;
    readonly workerCanShutdown: () => boolean | Promise<boolean>;
    readonly workerCanReplace: () => boolean | Promise<boolean>;
    readonly onWorkerChanged: (listener: () => void) => () => void;
}

export function prepareRoutedHost(options: RoutedHostOptions) {
    const masterEndpoint = sessionEndpoint(options.master);
    const workerEndpoint = options.worker;
    const router = new HostRouter({
        master: masterEndpoint, worker: workerEndpoint, masterSocket: options.masterSocket,
        workerSocket: options.workerSocket, buildId: options.buildId,
        reserveDelivery: (id, run) => reserveAgent(id, () => run()),
    });
    const attachments = new InteractiveAttachmentCoordinator(
        () => router.attachmentTree(), (id) => router.close(id, "detached"),
    );
    options.master.setExtensionSessions(router);
    options.master.registry.peerSessions = router;
    options.master.registry.subagentSessions = router;
    options.master.registry.subagentAdmission = router;
    options.master.setParkIdle(() => router.parkIdle());
    options.master.registry.openGuard = {
        beginCreate: (id, path, parentId) => router.beginMasterCreate(id, path, parentId),
        beginResume: (path) => router.beginMasterResume(path),
        end: (id) => router.endMasterOpen(id),
    };
    options.master.inboxDelivery.setExternalPump((seq) => router.pumpInbox("host", seq));
    options.master.handlers.setImportedSourceHash((summary) => router.importedSourceHash(summary));
    const snapshots = new RoutedSnapshots(masterEndpoint, workerEndpoint, (master, child) => {
        router.observe("host", master.residents);
        router.observe("w0", child.residents);
    });
    const stopMasterTracking = options.master.handlers.onRosterChanged(() => snapshots.refresh());
    const stopWorkerTracking = options.onWorkerChanged(() => snapshots.refresh());
    snapshots.refresh();

    const route = (from: SessionOwner) => (request: HostRequest): Promise<string | undefined> => {
        const target = sessionTarget(request);
        if (!options.workerReady() && from === "host") return Promise.resolve(undefined);
        return target === undefined ? Promise.resolve(undefined) : router.socketFor(from, target);
    };
    async function reserveAgent<T>(id: string, run: (reserved: boolean, path?: string) => Promise<T>): Promise<T> {
        const local = await masterEndpoint.resident(id);
        const path = local?.sessionPath ?? await options.master.handlers.storedSessionPath(id)
            ?? (await workerEndpoint.resident(id))?.sessionPath
            ?? (await workerEndpoint.list()).find((row) => row.id === id)?.session_path;
        if (path === undefined) return await run(false);
        let entered = false;
        try {
            return await withSessionReservation(path, options.reservations, async (canonicalPath) => {
                entered = true;
                return await run(true, canonicalPath);
            });
        } catch (error) {
            if (!entered && (error as NodeJS.ErrnoException).code === "ENOENT") return await run(false);
            throw error;
        }
    }
    const resumeSession = async (path: string) => {
        while (true) {
            const inspected = await masterEndpoint.inspect(path);
            router.assertResumeAvailable(inspected.id, inspected.parentId);
            const tree = await masterEndpoint.tree(inspected.id);
            const members = await Promise.all(tree.map((id) => masterEndpoint.resident(id)));
            const paths = [inspected.sessionPath, ...members.flatMap((member) =>
                member === undefined ? [] : [member.sessionPath]
            )];
            try {
                return await withSessionReservations(paths, options.reservations, async (canonicalPaths) => {
                    if (options.workerReady()) return await router.resume(inspected.sessionPath, new Set(canonicalPaths));
                    const session = await masterEndpoint.resume(inspected.sessionPath, { reserved: true });
                    router.observe("host", [session]);
                    return session;
                });
            } catch (error) {
                if (error instanceof SessionTransferReservationsChanged) continue;
                throw error;
            }
        }
    };
    const common = {
        locateAgent: (id: string) => reserveAgent(id, async (reserved, path) => {
            if (!options.workerReady()) {
                try {
                    const session = path === undefined
                        ? await masterEndpoint.find(id, reserved)
                        : await masterEndpoint.resume(path, { reserved });
                    if (session !== undefined) router.observe("host", [session]);
                } catch (error) {
                    return {
                        type: "agent_location_failed" as const, reason: "worker_unavailable" as const,
                        message: userFacingMessage(error) ?? "The session could not be loaded.",
                    };
                }
            }
            return await router.locate(id, reserved);
        }),
        createAgent: async (request: Parameters<HostRouter["create"]>[0]) => {
            if (options.workerReady()) return await router.create(request);
            const session = await masterEndpoint.create(request);
            router.observe("host", [session]);
            return session;
        },
        resumeAgent: resumeSession,
        listAgents: () => router.list(),
        onRosterChanged: (listener: () => void) => snapshots.onChanged(listener),
        listBackgroundAgents: () => snapshots.list(),
        readWorkIndex: () => snapshots.workIndex(),
        attachmentCoordinator: attachments,
        renameSession: (id: string, name: string | null) => reserveAgent(id, (reserved) => router.rename(id, name, reserved)),
        trashSession: (id: string) => reserveAgent(id, (reserved) => router.trash(id, reserved)),
        closeAgent: (id: string, reason?: Parameters<HostRouter["close"]>[1]) => router.close(id, reason),
        blockSession: (request: Parameters<HostRouter["block"]>[0]) => router.block(request),
        unblockSession: (request: Parameters<HostRouter["unblock"]>[0]) => router.unblock(request),
        syncAgentContext: (id: string) => router.sync(id),
        readSessionFacts: (sessions: Parameters<HostRouter["facts"]>[0], include: Parameters<HostRouter["facts"]>[1]) =>
            router.facts(sessions, include),
        searchSessions: (query: Parameters<HostRouter["search"]>[0]) => router.search(query),
        importSession: (path: string) => router.importSession(path),
        listImportableSessions: (workspace: string | undefined) => router.listImportableSessions(workspace),
    };
    const branch = (owner: SessionOwner, host: SessionHost): NonNullable<StartHostServerOptions["branchAgent"]> =>
        async (request) => {
            if (!await router.beginBranch(owner, request.sourceId)) return undefined;
            try { return await host.handlers.branchAgent(request); }
            finally { router.endBranch(request.sourceId); }
        };
    const masterHandlers: Partial<StartHostServerOptions> = {
        ...common,
        findAgent: async (id) => await reserveAgent(id, async (reserved, path) => {
            if (!options.workerReady()) {
                const session = path === undefined
                    ? await masterEndpoint.find(id, reserved)
                    : await masterEndpoint.resume(path, { reserved });
                if (session === undefined) return undefined;
                router.observe("host", [session]);
            } else if (!await router.find("host", id, reserved)) return undefined;
            await snapshots.wait();
            return options.master.registry.find(id);
        }),
        branchAgent: branch("host", options.master),
        routeRequest: route("host"),
        canShutdown: async () => options.master.handlers.canShutdown() && await options.workerCanShutdown(),
        canReplace: async () => options.master.handlers.canReplace() && await options.workerCanReplace(),
    };
    return {
        router, attachments, common, branch, route, reserveAgent, snapshots, masterHandlers,
        close() {
            options.master.setExtensionSessions(options.master.localExtensionSessions);
            options.master.registry.peerSessions = undefined;
            options.master.registry.subagentSessions = undefined;
            options.master.registry.subagentAdmission = undefined;
            options.master.registry.openGuard = undefined;
            options.master.inboxDelivery.setExternalPump(undefined);
            options.master.handlers.setImportedSourceHash(undefined);
            stopMasterTracking();
            stopWorkerTracking();
        },
    };
}

export function sessionTarget(request: HostRequest): string | undefined {
    switch (request.type) {
        case "attach": return request.agent_id;
        case "branch_agent": return request.source_agent_id;
        default: return undefined;
    }
}
