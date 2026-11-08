import { dirname, join } from "node:path";
import { readSessionHeader } from "../../store/session-store.ts";

import { defaultHostSocketPath } from "../lockfile.ts";
import type { HostIdentity } from "../protocol.ts";
import { startWorkerServer, type HostListener, type StartHostServerOptions } from "../server.ts";
import { startSessionHost, type SessionHost, type StartSessionHostOptions } from "../session-host.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import { prepareRoutedHost } from "./routing.ts";
import { ForwardedShutdowns, forwardLocalRequest } from "./public-forward.ts";
import { MasterInboxBridge, WorkerInboxBridge } from "./inbox.ts";

export function inProcessWorkerSocket(home: string, index = 0): string {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid session worker index");
    const path = join(dirname(defaultHostSocketPath(home)), `w${index}.sock`);
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
    workerHealth?(): readonly WorkerHealth[];
    start(identity: Pick<HostIdentity, "pid" | "started_at">): Promise<void>;
    stopMaintenance(): void;
    waitingOn(): Promise<readonly StopWaitTarget[]>;
    hasSession(id: string): boolean | Promise<boolean>;
    cutSession(id: string, reason: string): Promise<boolean>;
    clearProviderSelection(provider: string): Promise<void>;
    notifyModelCatalogChanged(): void;
    notifyAnnexChanged(url: string | undefined): Promise<void>;
    flushStores(): Promise<void>;
    knowsSession(id: string): Promise<boolean>;
    waitForForwardedShutdowns(): Promise<void>;
    close(): Promise<void>;
}

export interface WorkerHealth {
    readonly id: string;
    readonly index: number;
    readonly generation: number;
    readonly pid?: number;
    readonly state: "starting" | "ready" | "replaced" | "unavailable";
    readonly reason?: string;
}

export async function prepareInProcessWorker(options: InProcessWorkerOptions): Promise<InProcessWorker> {
    const restoringSessions = options.sessionOptions.restoringSessions ?? new Map();
    const forwardedShutdowns = new ForwardedShutdowns();
    const worker = await startSessionHost({ ...options.sessionOptions, restoringSessions, sessionWorker: true });
    worker.startStorage();
    let workerReady = false;
    let workerStarting = true;
    const started = Promise.withResolvers<void>();
    const finishStarting = (): void => { workerStarting = false; started.resolve(); };
    const routed = prepareRoutedHost({
        master: options.master, worker: sessionEndpoint(worker), masterSocket: options.masterSocket,
        workerSocket: options.workerSocket, buildId: options.buildId, reservations: restoringSessions,
        workerGeneration: () => 1,
        workerReady: () => workerReady,
        workerStarting: () => workerStarting,
        waitForWorkerStart: () => started.promise,
        workerCanShutdown: () => worker.handlers.canShutdown(),
        workerCanReplace: () => worker.handlers.canReplace(),
        onWorkerChanged: (listener) => worker.handlers.onRosterChanged(listener),
    });
    const { router } = routed;
    const masterInbox: MasterInboxBridge = new MasterInboxBridge(options.master.inboxDelivery, (method, args, signal): Promise<unknown> =>
        workerInbox.handle(method, args, signal ?? new AbortController().signal), (id) => router.inboxOwner(id) === "w0");
    const workerInbox: WorkerInboxBridge = new WorkerInboxBridge((method, args, signal): Promise<unknown> =>
        masterInbox.handle(method, args, signal));
    worker.inboxDelivery.setSessionBridge(workerInbox);
    worker.setExtensionSessions(router);
    worker.registry.peerSessions = router;
    worker.registry.subagentSessions = router;
    worker.registry.subagentAdmission = router;
    const opening = new Set<string>();
    worker.registry.openGuard = {
        async beginCreate(id, path, parentId) {
            if (opening.has(id)) throw new Error(`Resident agent ${id} is starting`);
            if (parentId === undefined) return;
            await router.beginWorkerCreate("w0", id, path, parentId);
            opening.add(id);
        },
        async beginResume(path) {
            const { id } = await readSessionHeader(path);
            if (opening.has(id)) throw new Error(`Resident agent ${id} is starting`);
            return id;
        },
        end(id) {
            if (opening.delete(id)) router.endWorkerOpen(id);
        },
    };
    worker.setParkIdle(async () => {});
    worker.inboxDelivery.setExternalPump((seq) => router.pumpInbox("w0", seq));
    worker.handlers.setImportedSourceHash((summary) => router.importedSourceHash(summary));
    let server: HostListener | undefined;
    return {
        masterHandlers: routed.masterHandlers,
        async start(identity) {
            workerStarting = true;
            try {
                server = await startWorkerServer({
                    ...worker.handlers,
                    ...routed.common,
                    socketPath: options.workerSocket,
                    lockPath: options.lockPath,
                    buildId: options.buildId,
                    capabilities: options.capabilities,
                    pid: identity.pid,
                    startedAt: identity.started_at,
                    forwardMasterRequest: (request, send, signal) =>
                        forwardedShutdowns.forward(request, () => forwardLocalRequest(options.masterSocket, request, send, signal)),
                    findAgent: async (id) => await routed.reserveAgent(id, async (reserved) => {
                        if (!await router.find("w0", id, reserved)) return undefined;
                        await routed.snapshots.wait();
                        return worker.registry.find(id);
                    }),
                    branchAgent: routed.branch("w0", worker),
                    routeRequest: routed.route("w0"),
                    canShutdown: () => false,
                    canReplace: () => false,
                }, { id: "w0", index: 0, count: 1, generation: 1 });
                workerReady = true;
            } finally {
                finishStarting();
            }
        },
        stopMaintenance: () => worker.stopMaintenance(),
        waitingOn: () => router.stopWaitTargets(),
        hasSession: (id) => worker.registry.agents.has(id)
            || worker.registry.startingIds.has(id) || worker.registry.trashingIds.has(id),
        cutSession: (id, reason) => router.cut(id, reason),
        clearProviderSelection: (provider) => worker.clearProviderSelection(provider),
        notifyModelCatalogChanged: () => worker.registry.notifyModelCatalogChanged(),
        notifyAnnexChanged: async () => {},
        flushStores: () => router.flush(),
        async knowsSession(id) {
            if (workerStarting) await started.promise;
            if (!workerReady) return false;
            const owner = router.inboxOwner(id);
            const sessions = owner === "host" ? await options.master.handlers.listAgents() : await worker.handlers.listAgents();
            return sessions.some((session) => session.id === id);
        },
        waitForForwardedShutdowns: () => forwardedShutdowns.wait(),
        async close() {
            workerReady = false;
            finishStarting();
            routed.close();
            worker.setExtensionSessions(worker.localExtensionSessions);
            worker.registry.peerSessions = undefined;
            worker.registry.subagentSessions = undefined;
            worker.registry.subagentAdmission = undefined;
            worker.registry.openGuard = undefined;
            worker.inboxDelivery.setExternalPump(undefined);
            worker.handlers.setImportedSourceHash(undefined);
            try { await server?.close(); }
            finally {
                try { await worker.close(); }
                finally {
                    await workerInbox.drain();
                    masterInbox.close();
                }
            }
        },
    };
}
