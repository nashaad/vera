import { UserFacingError } from "../../user-facing-error.ts";
import { randomUUID } from "node:crypto";
import type { HostRequest } from "../protocol.ts";
import type { StartHostServerOptions } from "../server.ts";
import type { SessionHost } from "../session-host.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import { withSessionReservation, withSessionReservations, type RestoringSessions } from "../session-host/storage.ts";
import { InteractiveAttachmentCoordinator } from "../attachment-coordinator.ts";
import { HostRouter, SessionTransferReservationsChanged, type RouterWorker } from "./router.ts";
import type { SessionEndpoint } from "./session-endpoint.ts";
import type { SessionOwner } from "./roster.ts";
import { RoutedSnapshots } from "./snapshots.ts";

export interface RoutedHostOptions {
    readonly master: SessionHost;
    readonly worker: SessionEndpoint;
    readonly masterSocket: string;
    readonly workerSocket: string;
    readonly buildId: string;
    readonly workerGeneration: () => number;
    readonly reservations: RestoringSessions;
    readonly workerReady: () => boolean;
    readonly workerStarting: () => boolean;
    readonly waitForWorkerStart: () => Promise<void>;
    readonly workerCanShutdown: () => boolean | Promise<boolean>;
    readonly workerCanReplace: () => boolean | Promise<boolean>;
    readonly onWorkerChanged: (listener: () => void) => () => void;
    readonly extraWorkers?: readonly (RouterWorker & {
        readonly canShutdown: () => boolean | Promise<boolean>;
        readonly canReplace: () => boolean | Promise<boolean>;
    })[];
    readonly keepResidentOwner?: boolean;
}

export function prepareRoutedHost(options: RoutedHostOptions) {
    const masterEndpoint = sessionEndpoint(options.master);
    const workerEndpoint = options.worker;
    const workers: readonly RouterWorker[] = [{
        id: "w0", endpoint: workerEndpoint, socket: options.workerSocket,
        generation: options.workerGeneration, ready: options.workerReady,
    }, ...options.extraWorkers ?? []];
    const readyWorkers = (): readonly RouterWorker[] => workers.filter((worker) => worker.ready());
    const router = new HostRouter({
        master: masterEndpoint, worker: workerEndpoint, masterSocket: options.masterSocket,
        workerSocket: options.workerSocket, buildId: options.buildId,
        workerGeneration: options.workerGeneration,
        workerReady: options.workerReady,
        extraWorkers: options.extraWorkers,
        keepResidentOwner: options.keepResidentOwner,
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
    const snapshots = new RoutedSnapshots(masterEndpoint, workers, (owner, snapshot) => {
        router.observe(owner, snapshot.residents);
        router.observeStored(owner, snapshot.summaries);
    });
    const stopMasterTracking = options.master.handlers.onRosterChanged(() => snapshots.refresh());
    const stopWorkerTracking = options.onWorkerChanged(() => snapshots.refresh());
    snapshots.refresh();

    const route = (from: SessionOwner) => (request: HostRequest): Promise<string | undefined> => {
        const target = sessionTarget(request);
        if (readyWorkers().length === 0 && from === "host") return Promise.resolve(undefined);
        return target === undefined ? Promise.resolve(undefined) : router.socketFor(from, target);
    };
    async function reserveAgent<T>(id: string, run: (reserved: boolean, path?: string) => Promise<T>): Promise<T> {
        const local = await masterEndpoint.resident(id);
        const residents = await Promise.all(readyWorkers().map((worker) => worker.endpoint.resident(id)));
        const rows = await Promise.all(readyWorkers().map((worker) => worker.endpoint.list()));
        const path = local?.sessionPath ?? await options.master.handlers.storedSessionPath(id)
            ?? residents.find((resident) => resident !== undefined)?.sessionPath
            ?? rows.flat().find((row) => row.id === id)?.session_path;
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
    async function requireWorker(waitForStart = true): Promise<void> {
        if (waitForStart && options.workerStarting()) await options.waitForWorkerStart();
        if (readyWorkers().length === 0) throw new UserFacingError("The session worker is unavailable.");
    }
    const resumeSession = async (path: string) => {
        await requireWorker(false);
        await router.waitForImports();
        while (true) {
            const inspected = await router.inspectForResume(path);
            router.assertResumeAvailable(inspected.id, inspected.parentId);
            const tree = await masterEndpoint.tree(inspected.id);
            const members = await Promise.all(tree.map((id) => masterEndpoint.resident(id)));
            const paths = [inspected.sessionPath, ...members.flatMap((member) =>
                member === undefined ? [] : [member.sessionPath]
            )];
            try {
                return await withSessionReservations(paths, options.reservations, async (canonicalPaths) => {
                    return await router.resume(inspected.sessionPath, new Set(canonicalPaths));
                });
            } catch (error) {
                if (error instanceof SessionTransferReservationsChanged) continue;
                throw error;
            }
        }
    };
    const common = {
        locateAgent: async (id: string) => {
            await router.waitForImports();
            if (readyWorkers().length === 0) {
                if (await masterEndpoint.resident(id) !== undefined) {
                    return {
                        type: "agent_location" as const, socket_path: options.masterSocket,
                        worker_id: "host", worker_generation: 1, build_id: options.buildId,
                    };
                }
                return options.workerStarting()
                    ? { type: "agent_location_failed" as const, reason: "starting" as const, message: "The session worker is starting." }
                    : { type: "agent_location_failed" as const, reason: "worker_unavailable" as const, message: "The session worker is unavailable." };
            }
            return await reserveAgent(id, (reserved) => router.locate(id, reserved));
        },
        createAgent: async (request: Parameters<HostRouter["create"]>[0]) => {
            await requireWorker();
            await router.waitForImports();
            return await router.create(request);
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
            const id = request.id ?? randomUUID();
            let opened = false;
            try {
                if (owner !== "host") {
                    const path = request.sessionPath ?? (request.ephemeral === true ? undefined : host.registry.options.sessionPathForId?.(id));
                    await router.beginWorkerCreate(owner, id, path);
                    opened = true;
                }
                return await host.handlers.branchAgent({ ...request, id });
            } finally {
                if (opened) router.endWorkerOpen(id);
                router.endBranch(request.sourceId);
            }
        };
    const masterHandlers: Partial<StartHostServerOptions> = {
        ...common,
        readWorkersReady: () => readyWorkers().length,
        readyLocation: async (id) => {
            const location = await common.locateAgent(id);
            if (location.type === "agent_location_failed") throw new Error(location.message);
            return location;
        },
        findAgent: async (id) => {
            await router.waitForImports();
            if (readyWorkers().length === 0) {
                if (await masterEndpoint.resident(id) !== undefined) return options.master.registry.find(id);
                await requireWorker();
            }
            return await reserveAgent(id, async (reserved) => {
                if (!await router.find("host", id, reserved)) return undefined;
                await snapshots.wait();
                return options.master.registry.find(id);
            });
        },
        branchAgent: branch("host", options.master),
        routeRequest: route("host"),
        canShutdown: async () => options.master.handlers.canShutdown() && await options.workerCanShutdown()
            && (await Promise.all((options.extraWorkers ?? []).map((worker) => worker.canShutdown()))).every(Boolean),
        canReplace: async () => options.master.handlers.canReplace() && await options.workerCanReplace()
            && (await Promise.all((options.extraWorkers ?? []).map((worker) => worker.canReplace()))).every(Boolean),
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
