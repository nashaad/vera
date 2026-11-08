import type { StartResidentHostOptions } from "../runtime.ts";
import { inProcessWorkerSocket, type InProcessWorker, type InProcessWorkerOptions } from "./in-process.ts";
import { ControlReservations } from "./reservations.ts";
import { remoteSessionEndpoint } from "./remote-endpoint.ts";
import { serveRoutedMethod } from "./remote-routing.ts";
import { prepareRoutedHost } from "./routing.ts";
import { startSessionWorkerSupervisor, WorkerGenerations, type SessionWorkerSupervisor } from "./supervisor.ts";
import { COMMON_METHODS, type WorkerBootstrap, type WorkerStartOptions } from "./worker-control.ts";
import type { ControlPeer } from "./control.ts";
import { ForwardedShutdowns, servePublicRequest } from "./public-forward.ts";
import type { WorkerOwner } from "./roster.ts";
import type { SessionEndpoint } from "./session-endpoint.ts";
import { startWorkerControlServer, type WorkerControlServer } from "./control-server.ts";
import type { createCredentialBroker } from "./credentials.ts";
import { createMasterGlobals, type GlobalChange } from "./global-services.ts";
import { applyConfigDefaults } from "./config-defaults.ts";

export interface ProcessWorkerOptions extends InProcessWorkerOptions {
    readonly hostOptions: StartResidentHostOptions;
    readonly workerCount: number;
    readonly credentials: ReturnType<typeof createCredentialBroker>;
    readonly onGlobalChangeReady: (notify: (kind: GlobalChange) => void) => void;
}

interface WorkerSlot {
    readonly id: WorkerOwner;
    readonly index: number;
    readonly socket: string;
    readonly connected: PromiseWithResolvers<ControlPeer>;
    readonly started: PromiseWithResolvers<void>;
    readonly exited: PromiseWithResolvers<void>;
    readonly endpoint: SessionEndpoint;
    readonly broker: ControlReservations;
    peer?: ControlPeer;
    supervisor?: SessionWorkerSupervisor;
    generation: number;
    ready: boolean;
    starting: boolean;
    closed: boolean;
    stopping?: Promise<void>;
}

export function prepareProcessWorker(options: ProcessWorkerOptions): InProcessWorker {
    const reservations = options.sessionOptions.restoringSessions ?? new Map();
    const forwardedShutdowns = new ForwardedShutdowns();
    const generations = new WorkerGenerations();
    const changes = new Set<() => void>();
    let control: WorkerControlServer | undefined;
    const slots: WorkerSlot[] = Array.from({ length: options.workerCount }, (_, index) => {
        const connected = Promise.withResolvers<ControlPeer>();
        const exited = Promise.withResolvers<void>();
        void connected.promise.catch(() => {});
        void exited.promise.catch(() => {});
        return {
            id: `w${index}`, index, socket: inProcessWorkerSocket(options.sessionOptions.home, index),
            connected, started: Promise.withResolvers<void>(), exited, endpoint: remoteSessionEndpoint(connected.promise),
            broker: new ControlReservations(reservations), generation: 0, ready: false, starting: true, closed: false,
        };
    });
    const notifyGlobalChange = (kind: GlobalChange): void => {
        if (kind === "config") applyConfigDefaults(options.master.registry, options.sessionOptions.currentConfig());
        for (const slot of slots) void slot.peer?.event("config_changed", kind).catch(() => {});
    };
    options.onGlobalChangeReady(notifyGlobalChange);
    const globals = createMasterGlobals({
        master: options.master,
        home: options.sessionOptions.home,
        lease: options.credentials.lease,
        changed: notifyGlobalChange,
        config: options.sessionOptions.currentConfig,
        configPath: options.hostOptions.inboxUserConfigPath ?? options.sessionOptions.configPath,
    });
    const requestWorker = async <T>(slot: WorkerSlot, method: string, args: readonly unknown[] = []): Promise<T> =>
        await (await slot.connected.promise).request<T>(method, args, AbortSignal.timeout(5_000));
    const workerOptions = (slot: WorkerSlot) => ({
        id: slot.id, endpoint: slot.endpoint, socket: slot.socket,
        generation: () => slot.generation, ready: () => slot.ready,
        canShutdown: async () => slot.ready && await requestWorker<boolean>(slot, "worker.canShutdown"),
        canReplace: async () => slot.ready && await requestWorker<boolean>(slot, "worker.canReplace"),
    });
    const first = slots[0]!;
    const routed = prepareRoutedHost({
        master: options.master, worker: first.endpoint, masterSocket: options.masterSocket,
        workerSocket: first.socket, buildId: options.buildId, reservations,
        workerGeneration: () => first.generation,
        workerReady: () => first.ready,
        workerStarting: () => slots.some((slot) => slot.starting),
        waitForWorkerStart: () => Promise.all(slots.map((slot) => slot.started.promise)).then(() => undefined),
        workerCanShutdown: () => workerOptions(first).canShutdown(),
        workerCanReplace: () => workerOptions(first).canReplace(),
        extraWorkers: slots.slice(1).map(workerOptions),
        keepResidentOwner: true,
        onWorkerChanged: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
    });
    const notifyChanges = (): void => { for (const listener of [...changes]) listener(); };
    const stopSnapshots = routed.snapshots.onChanged(() => {
        const value = { summaries: routed.snapshots.list(), workIndex: routed.snapshots.workIndex() };
        for (const slot of slots) void slot.peer?.event("snapshot", value).catch(() => {});
    });
    const hostOptions = options.hostOptions;
    const childOptions: WorkerStartOptions = {
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
        ...(hostOptions.inboxUserConfigPath === undefined ? {} : { inboxUserConfigPath: hostOptions.inboxUserConfigPath }),
    };
    const bootstrap: WorkerBootstrap = {
        options: childOptions, masterSocket: options.masterSocket, lockPath: options.lockPath,
        buildId: options.buildId, capabilities: options.capabilities,
    };
    const startSlot = async (slot: WorkerSlot): Promise<void> => {
        try {
            slot.generation = generations.next(slot.id);
            slot.supervisor = await startSessionWorkerSupervisor({
                home: options.sessionOptions.home, socket: slot.socket, bootstrap,
                control,
                index: slot.index, count: slots.length, generation: slot.generation,
                onConnected(peer) {
                    slot.peer = peer;
                    slot.connected.resolve(peer);
                    void peer.closed.then(() => {
                        slot.closed = true;
                        slot.ready = false;
                        slot.starting = false;
                        notifyChanges();
                        slot.stopping = (async () => {
                            await slot.started.promise;
                            await slot.supervisor?.close();
                            slot.broker.close();
                            routed.router.workerExited(slot.id);
                            slot.exited.resolve();
                            notifyChanges();
                        })();
                        void slot.stopping.catch((error: unknown) => slot.exited.reject(error));
                    });
                },
                onEvent(event) {
                    if (event === "roster_delta") notifyChanges();
                },
                async handler(method, args, signal) {
                    if (method.startsWith("globals.")) return await globals.handle(method, args);
                    if (method === "public.request") {
                        if (slot.peer === undefined) throw new Error("Worker control is unavailable");
                        await servePublicRequest(slot.peer, options.masterSocket, args, signal, forwardedShutdowns);
                        return;
                    }
                    if (method === "reservation.acquire") {
                        if (!Array.isArray(args[0]) || !args[0].every((path) => typeof path === "string")) {
                            throw new Error("Invalid session reservation");
                        }
                        return await slot.broker.acquire(args[0] as string[], signal);
                    }
                    if (method === "reservation.release" && typeof args[0] === "string") {
                        slot.broker.release(args[0]);
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
                        await routed.router.waitForImports();
                        return await routed.reserveAgent(id, async (reserved) => {
                            if (!await routed.router.find(slot.id, id, reserved)) return false;
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
            if (slot.closed) throw new Error("Session worker closed before ready");
            slot.ready = true;
            routed.router.observe(slot.id, slot.supervisor.snapshot.residents);
            routed.router.observeStored(slot.id, slot.supervisor.snapshot.summaries);
        } catch (error) {
            if (slot.supervisor !== undefined) await slot.supervisor.close();
            slot.closed = true;
            slot.broker.close();
            routed.router.workerExited(slot.id);
            slot.exited.resolve();
            slot.connected.reject(error);
            throw error;
        } finally {
            slot.starting = false;
            slot.started.resolve();
        }
    };
    return {
        masterHandlers: routed.masterHandlers,
        async start() {
            control = await startWorkerControlServer(options.sessionOptions.home);
            const results = await Promise.allSettled(slots.map(startSlot));
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") {
                await Promise.allSettled(slots.flatMap((slot) => slot.supervisor === undefined ? [] : [slot.supervisor.close()]));
                await control.close();
                throw failure.reason;
            }
            routed.snapshots.refresh();
            await routed.snapshots.wait();
        },
        stopMaintenance() {
            for (const slot of slots) if (slot.ready) void requestWorker(slot, "worker.stopMaintenance").catch(() => {});
        },
        waitingOn: () => routed.router.stopWaitTargets(),
        async hasSession(id) {
            return (await Promise.all(slots.map(async (slot) => {
                if (slot.ready) {
                    try { return await requestWorker<boolean>(slot, "worker.hasSession", [id]); }
                    catch { if (!slot.closed) return true; }
                }
                if (!slot.closed) return true;
                try { await slot.exited.promise; return false; }
                catch { return true; }
            }))).some(Boolean);
        },
        cutSession: (id, reason) => routed.router.cut(id, reason),
        async clearProviderSelection(provider) {
            await Promise.all(slots.filter((slot) => slot.ready)
                .map((slot) => requestWorker<void>(slot, "worker.clearProviderSelection", [provider])));
        },
        notifyModelCatalogChanged() {
            for (const slot of slots) if (slot.ready) void requestWorker(slot, "worker.catalogChanged").catch(() => {});
        },
        flushStores: () => routed.router.flush(),
        waitForForwardedShutdowns: () => forwardedShutdowns.wait(),
        async close() {
            for (const slot of slots) {
                slot.ready = false;
                slot.starting = false;
            }
            stopSnapshots();
            routed.close();
            const results = await Promise.allSettled(slots.map(async (slot) => {
                if (slot.supervisor !== undefined) await slot.supervisor.close();
                else slot.connected.reject(new Error("Session worker was not started"));
                await slot.stopping;
                slot.broker.close();
            }));
            await control?.close();
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
        },
    };
}
