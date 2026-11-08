import { dirname, join } from "node:path";

import { defaultHostSocketPath } from "../lockfile.ts";
import type { HostIdentity, HostRequest } from "../protocol.ts";
import { startWorkerServer, type HostListener, type StartHostServerOptions } from "../server.ts";
import { startSessionHost, type SessionHost, type StartSessionHostOptions } from "../session-host.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import { HostRouter } from "./router.ts";
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
    cutSession(id: string, reason: string): Promise<boolean>;
    clearProviderSelection(provider: string): Promise<void>;
    notifyModelCatalogChanged(): void;
    flushStores(): Promise<void>;
    close(): Promise<void>;
}

export async function prepareInProcessWorker(options: InProcessWorkerOptions): Promise<InProcessWorker> {
    const worker = await startSessionHost({ ...options.sessionOptions, sessionWorker: true });
    const masterEndpoint = sessionEndpoint(options.master);
    const workerEndpoint = sessionEndpoint(worker);
    const router = new HostRouter({
        master: masterEndpoint,
        worker: workerEndpoint,
        masterSocket: options.masterSocket,
        workerSocket: options.workerSocket,
        buildId: options.buildId,
    });
    const attachments = new InteractiveAttachmentCoordinator(() => router.attachmentTree());
    options.master.setExtensionSessions(router);
    worker.setExtensionSessions(router);
    options.master.registry.peerSessions = router;
    worker.registry.peerSessions = router;
    options.master.registry.subagentSessions = router;
    worker.registry.subagentSessions = router;
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
        return target === undefined ? Promise.resolve(undefined) : router.socketFor(from, target);
    };
    const common = {
        locateAgent: (id: string) => router.locate(id),
        createAgent: (request: Parameters<HostRouter["create"]>[0]) => router.create(request),
        resumeAgent: (path: string) => router.resume(path),
        listAgents: () => router.list(),
        onRosterChanged: (listener: () => void) => snapshots.onChanged(listener),
        listBackgroundAgents: () => snapshots.list(),
        readWorkIndex: () => snapshots.workIndex(),
        attachmentCoordinator: attachments,
        renameSession: (id: string, name: string | null) => router.rename(id, name),
        trashSession: (id: string) => router.trash(id),
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
        findAgent: async (id) => {
            if (!await router.find("host", id)) return undefined;
            await snapshots.wait();
            return options.master.registry.find(id);
        },
        branchAgent: branch("host", options.master),
        routeRequest: route("host"),
        canShutdown: () => options.master.handlers.canShutdown() && worker.handlers.canShutdown(),
        canReplace: () => options.master.handlers.canReplace() && worker.handlers.canReplace(),
    };
    let server: HostListener | undefined;
    return {
        masterHandlers,
        async start(identity) {
            worker.startStorage();
            server = await startWorkerServer({
                ...worker.handlers,
                ...common,
                socketPath: options.workerSocket,
                lockPath: options.lockPath,
                buildId: options.buildId,
                capabilities: options.capabilities,
                pid: identity.pid,
                startedAt: identity.started_at,
                findAgent: async (id) => {
                    if (!await router.find("w0", id)) return undefined;
                    await snapshots.wait();
                    return worker.registry.find(id);
                },
                branchAgent: branch("w0", worker),
                routeRequest: route("w0"),
                canShutdown: () => false,
                canReplace: () => false,
            }, { id: "w0", index: 0, count: 1 });
        },
        stopMaintenance: () => worker.stopMaintenance(),
        waitingOn: () => router.stopWaitTargets(),
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
