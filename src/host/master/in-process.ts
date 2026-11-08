import { dirname, join } from "node:path";

import { userFacingMessage } from "../../user-facing-error.ts";
import { defaultHostSocketPath } from "../lockfile.ts";
import type { HostIdentity, HostRequest } from "../protocol.ts";
import { startWorkerServer, type HostListener, type StartHostServerOptions } from "../server.ts";
import { startSessionHost, type SessionHost, type StartSessionHostOptions } from "../session-host.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import { withSessionReservation, withSessionReservations } from "../session-host/storage.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import { HostRouter, SessionTransferReservationsChanged } from "./router.ts";
import { RoutedSnapshots } from "./snapshots.ts";
import { InteractiveAttachmentCoordinator } from "../attachment-coordinator.ts";
import type { SessionOwner } from "./roster.ts";

export function inProcessWorkerSocket(home: string): string {
    const path = join(dirname(defaultHostSocketPath(home)), "w0.sock");
    if (Buffer.byteLength(path, "utf8") >= 104) {
        throw new Error(`Worker socket path exceeds the 103-byte limit: ${path}`);
    }
    return path;
}

export interface InProcessWorkerOptions {
    readonly master: SessionHost;
    readonly sessionOptions: StartSessionHostOptions;
    readonly masterSocket: string;
    readonly workerSocket: string;
    readonly lockPath: string;
    readonly buildId: string;
    readonly capabilities: readonly string[];
}

export interface InProcessWorker {
    readonly masterHandlers: Partial<StartHostServerOptions>;
    start(identity: Pick<HostIdentity, "pid" | "started_at">): Promise<void>;
    stopMaintenance(): void;
    waitingOn(): Promise<readonly StopWaitTarget[]>;
    hasSession(id: string): boolean;
    cutSession(id: string, reason: string): Promise<boolean>;
    clearProviderSelection(provider: string): Promise<void>;
    notifyModelCatalogChanged(): void;
    flushStores(): Promise<void>;
    close(): Promise<void>;
}

export async function prepareInProcessWorker(options: InProcessWorkerOptions): Promise<InProcessWorker> {
    const restoringSessions = options.sessionOptions.restoringSessions ?? new Map();
    const worker = await startSessionHost({ ...options.sessionOptions, restoringSessions, sessionWorker: true });
    worker.startStorage();
    const masterEndpoint = sessionEndpoint(options.master);
    const workerEndpoint = sessionEndpoint(worker);
    const router = new HostRouter({
        master: masterEndpoint,
        worker: workerEndpoint,
        masterSocket: options.masterSocket,
        workerSocket: options.workerSocket,
        buildId: options.buildId,
        reserveDelivery: (id, run) => reserveAgent(id, () => run()),
    });
    const attachments = new InteractiveAttachmentCoordinator(() => router.attachmentTree());
    let workerReady = false;
    options.master.setExtensionSessions(router);
    worker.setExtensionSessions(router);
    options.master.registry.peerSessions = router;
    worker.registry.peerSessions = router;
    options.master.registry.subagentAdmission = router;
    worker.registry.subagentAdmission = router;
    options.master.setParkIdle(() => router.parkIdle());
    worker.setParkIdle(async () => {});
    options.master.registry.openGuard = {
        beginCreate: (id, path) => router.beginMasterCreate(id, path),
        beginResume: (path) => router.beginMasterResume(path),
        end: (id) => router.endMasterOpen(id),
    };
    options.master.inboxDelivery.setExternalPump((seq) => router.pumpInbox("host", seq));
    worker.inboxDelivery.setExternalPump((seq) => router.pumpInbox("w0", seq));
    options.master.handlers.setImportedSourceHash((summary) => router.importedSourceHash(summary));
    worker.handlers.setImportedSourceHash((summary) => router.importedSourceHash(summary));
    const snapshots = new RoutedSnapshots(masterEndpoint, workerEndpoint, (master, child) => {
        router.observe("host", master.residents);
        router.observe("w0", child.residents);
    });
    const stopMasterTracking = options.master.handlers.onRosterChanged(() => snapshots.refresh());
    const stopWorkerTracking = worker.handlers.onRosterChanged(() => snapshots.refresh());
    snapshots.refresh();
    const route = (from: SessionOwner) => (request: HostRequest): Promise<string | undefined> => {
        const target = sessionTarget(request);
        if (!workerReady && from === "host") return Promise.resolve(undefined);
        return target === undefined ? Promise.resolve(undefined) : router.socketFor(from, target);
    };
    const reserveAgent = async <T>(id: string, run: (reserved: boolean, path?: string) => Promise<T>): Promise<T> => {
        const resident = worker.registry.agents.get(id) ?? options.master.registry.agents.get(id);
        const path = resident?.store.path
            ?? await options.master.handlers.storedSessionPath(id)
            ?? await worker.handlers.storedSessionPath(id);
        if (path === undefined) return await run(false);
        let entered = false;
        try {
            return await withSessionReservation(path, restoringSessions, async (canonicalPath) => {
                entered = true;
                return await run(true, canonicalPath);
            });
        } catch (error) {
            if (!entered && (error as NodeJS.ErrnoException).code === "ENOENT") return await run(false);
            throw error;
        }
    };
    options.master.registry.subagentSessions = router;
    worker.registry.subagentSessions = router;
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
                return await withSessionReservations(paths, restoringSessions, async (canonicalPaths) => {
                    if (workerReady) return await router.resume(inspected.sessionPath, new Set(canonicalPaths));
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
            if (!workerReady) {
                try {
                    const session = path === undefined
                        ? await masterEndpoint.find(id, reserved)
                        : await masterEndpoint.resume(path, { reserved });
                    if (session !== undefined) router.observe("host", [session]);
                } catch (error) {
                    return {
                        type: "agent_location_failed" as const,
                        reason: "worker_unavailable" as const,
                        message: userFacingMessage(error) ?? "The session could not be loaded.",
                    };
                }
            }
            return await router.locate(id, reserved);
        }),
        createAgent: async (request: Parameters<HostRouter["create"]>[0]) => {
            if (workerReady) return await router.create(request);
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
            try {
                return await host.handlers.branchAgent(request);
            } finally {
                router.endBranch(request.sourceId);
            }
        };
    const masterHandlers: Partial<StartHostServerOptions> = {
        ...common,
        findAgent: async (id) => await reserveAgent(id, async (reserved, path) => {
            if (!workerReady) {
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
        canShutdown: () => options.master.handlers.canShutdown() && worker.handlers.canShutdown(),
        canReplace: () => options.master.handlers.canReplace() && worker.handlers.canReplace(),
    };
    let server: HostListener | undefined;
    return {
        masterHandlers,
        async start(identity) {
            server = await startWorkerServer({
                ...worker.handlers,
                ...common,
                socketPath: options.workerSocket,
                lockPath: options.lockPath,
                buildId: options.buildId,
                capabilities: options.capabilities,
                pid: identity.pid,
                startedAt: identity.started_at,
                findAgent: async (id) => await reserveAgent(id, async (reserved) => {
                    if (!await router.find("w0", id, reserved)) return undefined;
                    await snapshots.wait();
                    return worker.registry.find(id);
                }),
                branchAgent: branch("w0", worker),
                routeRequest: route("w0"),
                canShutdown: () => false,
                canReplace: () => false,
            }, { id: "w0", index: 0, count: 1 });
            workerReady = true;
        },
        stopMaintenance: () => worker.stopMaintenance(),
        waitingOn: () => router.stopWaitTargets(),
        hasSession: (id) => worker.registry.agents.has(id)
            || worker.registry.startingIds.has(id)
            || worker.registry.trashingIds.has(id),
        cutSession: (id, reason) => router.cut(id, reason),
        clearProviderSelection: (provider) => worker.clearProviderSelection(provider),
        notifyModelCatalogChanged: () => worker.registry.notifyModelCatalogChanged(),
        flushStores: () => router.flush(),
        async close() {
            options.master.setExtensionSessions(options.master.localExtensionSessions);
            worker.setExtensionSessions(worker.localExtensionSessions);
            options.master.registry.peerSessions = undefined;
            worker.registry.peerSessions = undefined;
            options.master.registry.subagentSessions = undefined;
            worker.registry.subagentSessions = undefined;
            options.master.registry.subagentAdmission = undefined;
            worker.registry.subagentAdmission = undefined;
            options.master.registry.openGuard = undefined;
            options.master.inboxDelivery.setExternalPump(undefined);
            worker.inboxDelivery.setExternalPump(undefined);
            options.master.handlers.setImportedSourceHash(undefined);
            worker.handlers.setImportedSourceHash(undefined);
            stopMasterTracking();
            stopWorkerTracking();
            try {
                await server?.close();
            } finally {
                await worker.close();
            }
        },
    };
}

function sessionTarget(request: HostRequest): string | undefined {
    switch (request.type) {
        case "attach":
            return request.agent_id;
        case "branch_agent":
            return request.source_agent_id;
        default:
            return undefined;
    }
}
