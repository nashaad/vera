import type { StartResidentHostOptions } from "../runtime.ts";
import type { InProcessWorker, InProcessWorkerOptions } from "./in-process.ts";
import { ControlReservations } from "./reservations.ts";
import { remoteSessionEndpoint } from "./remote-endpoint.ts";
import { serveRoutedMethod } from "./remote-routing.ts";
import { prepareRoutedHost } from "./routing.ts";
import { startSessionWorkerSupervisor, type SessionWorkerSupervisor } from "./supervisor.ts";
import { COMMON_METHODS, type WorkerBootstrap, type WorkerStartOptions } from "./worker-control.ts";
import type { ControlPeer } from "./control.ts";

export interface ProcessWorkerOptions extends InProcessWorkerOptions {
    readonly hostOptions: StartResidentHostOptions;
}

export function prepareProcessWorker(options: ProcessWorkerOptions): InProcessWorker {
    const reservations = options.sessionOptions.restoringSessions ?? new Map();
    const broker = new ControlReservations(reservations);
    const connected = Promise.withResolvers<ControlPeer>();
    const changes = new Set<() => void>();
    let peer: ControlPeer | undefined;
    let supervisor: SessionWorkerSupervisor | undefined;
    let workerReady = false;
    const requestWorker = async <T>(method: string, args: readonly unknown[] = []): Promise<T> =>
        await (await connected.promise).request<T>(method, args, AbortSignal.timeout(5_000));
    const routed = prepareRoutedHost({
        master: options.master,
        worker: remoteSessionEndpoint(connected.promise),
        masterSocket: options.masterSocket,
        workerSocket: options.workerSocket,
        buildId: options.buildId,
        reservations,
        workerReady: () => workerReady,
        workerCanShutdown: async () => workerReady && await requestWorker<boolean>("worker.canShutdown"),
        workerCanReplace: async () => workerReady && await requestWorker<boolean>("worker.canReplace"),
        onWorkerChanged: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
    });
    const stopSnapshots = routed.snapshots.onChanged(() => {
        void peer?.event("snapshot", { summaries: routed.snapshots.list(), workIndex: routed.snapshots.workIndex() }).catch(() => {});
    });
    const hostOptions = options.hostOptions;
    const workerOptions: WorkerStartOptions = {
        config: hostOptions.config,
        home: options.sessionOptions.home,
        configPath: options.sessionOptions.configPath,
        blockedDirectory: options.sessionOptions.blockedDirectory,
        modelFailureLedgerPath: options.sessionOptions.modelFailureLedgerPath,
        ...(hostOptions.sessionDirectory === undefined ? {} : { sessionDirectory: hostOptions.sessionDirectory }),
        ...(hostOptions.projectRoot === undefined ? {} : { projectRoot: hostOptions.projectRoot }),
        ...(hostOptions.permissionPreferencesPath === undefined ? {} : { permissionPreferencesPath: hostOptions.permissionPreferencesPath }),
        ...(hostOptions.eventLogDirectory === undefined ? {} : { eventLogDirectory: hostOptions.eventLogDirectory }),
        ...(hostOptions.importRoots === undefined ? {} : { importRoots: hostOptions.importRoots }),
    };
    const bootstrap: WorkerBootstrap = {
        options: workerOptions, masterSocket: options.masterSocket, lockPath: options.lockPath,
        buildId: options.buildId, capabilities: options.capabilities,
    };
    return {
        masterHandlers: routed.masterHandlers,
        async start() {
            try {
                supervisor = await startSessionWorkerSupervisor({
                    home: options.sessionOptions.home, socket: options.workerSocket, bootstrap,
                    onConnected(value) {
                        peer = value;
                        connected.resolve(value);
                        void value.closed.then(() => { workerReady = false; broker.close(); });
                    },
                    onEvent(event) {
                        if (event === "roster_delta") for (const listener of [...changes]) listener();
                    },
                    async handler(method, args, signal) {
                        if (method === "reservation.acquire") {
                            if (!Array.isArray(args[0]) || !args[0].every((path) => typeof path === "string")) {
                                throw new Error("Invalid session reservation");
                            }
                            return await broker.acquire(args[0] as string[], signal);
                        }
                        if (method === "reservation.release" && typeof args[0] === "string") {
                            broker.release(args[0]);
                            return;
                        }
                        if (method.startsWith("router.")) {
                            return await serveRoutedMethod(routed.router, "router", method.slice(7), args, signal);
                        }
                        if (method.startsWith("attachment.")) {
                            return await serveRoutedMethod(routed.attachments, "attachment", method.slice(11), args, signal);
                        }
                        if (method === "host.findWorker" && typeof args[0] === "string") {
                            const id = args[0];
                            return await routed.reserveAgent(id, async (reserved) => {
                                if (!await routed.router.find("w0", id, reserved)) return false;
                                await routed.snapshots.wait();
                                return true;
                            });
                        }
                        if (method.startsWith("host.") && (COMMON_METHODS as readonly string[]).includes(method.slice(5))) {
                            const name = method.slice(5) as keyof typeof routed.common;
                            const invoke = routed.common[name] as (...values: unknown[]) => unknown;
                            return await invoke(...args);
                        }
                        throw new Error("Unknown master control request");
                    },
                });
                workerReady = true;
                routed.router.observe("w0", supervisor.snapshot.residents);
                routed.snapshots.refresh();
            } catch (error) {
                connected.reject(error);
                throw error;
            }
        },
        stopMaintenance() {
            if (workerReady) void requestWorker("worker.stopMaintenance").catch(() => {});
        },
        waitingOn: () => routed.router.stopWaitTargets(),
        hasSession: (id) => workerReady ? requestWorker<boolean>("worker.hasSession", [id]) : false,
        cutSession: (id, reason) => routed.router.cut(id, reason),
        clearProviderSelection: (provider) => requestWorker<void>("worker.clearProviderSelection", [provider]),
        notifyModelCatalogChanged() { if (workerReady) void requestWorker("worker.catalogChanged").catch(() => {}); },
        flushStores: () => routed.router.flush(),
        async close() {
            workerReady = false;
            stopSnapshots();
            routed.close();
            broker.close();
            if (supervisor !== undefined) await supervisor.close();
            else connected.reject(new Error("Session worker was not started"));
        },
    };
}
