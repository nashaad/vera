import type { StartResidentHostOptions } from "../runtime.ts";
import { inProcessWorkerSocket, type InProcessWorker, type InProcessWorkerOptions } from "./in-process.ts";
import { ControlReservations } from "./reservations.ts";
import { remoteSessionEndpoint } from "./remote-endpoint.ts";
import { serveRoutedMethod } from "./remote-routing.ts";
import { prepareRoutedHost } from "./routing.ts";
import { startSessionWorkerSupervisor, WorkerGenerations, type SessionWorkerSupervisor } from "./supervisor.ts";
import { COMMON_METHODS, type WorkerBootstrap, type WorkerStartOptions } from "./worker-control.ts";
import type { ControlPeer } from "./control.ts";
import { MasterInboxBridge } from "./inbox.ts";
import { ForwardedShutdowns, servePublicRequest } from "./public-forward.ts";
import type { WorkerOwner } from "./roster.ts";
import type { SessionEndpoint } from "./session-endpoint.ts";
import type { WorkerRecoverySession } from "./router.ts";
import { readSessionSnapshot, readSessionTurnState } from "../../store/session-store.ts";
import { recoveryFileStamp, sameRecoveryFile } from "./recovery-file.ts";
import { startWorkerControlServer, type WorkerControlServer } from "./control-server.ts";
import type { createCredentialBroker } from "./credentials.ts";
import { createMasterGlobals, type GlobalChange } from "./global-services.ts";
import { applyConfigDefaults } from "./config-defaults.ts";
import { buildExtensionCatalog, serveExtensionRequest } from "./extension-catalog.ts";
import type { PendingWorkerRecord, RecoverableWorker, WorkerRecord, WorkerRecordScan } from "./worker-record.ts";
import { occupiedWorkerSockets, socketOccupied, verifiedWorkerHello, type WorkerSocket } from "./worker-sockets.ts";
import { requestHostIdentity } from "../protocol.ts";

export interface ProcessWorkerOptions extends InProcessWorkerOptions {
    readonly hostOptions: StartResidentHostOptions;
    readonly workerCount: number;
    readonly credentials: ReturnType<typeof createCredentialBroker>;
    readonly recoverableWorkers: readonly RecoverableWorker[];
    readonly stoppedWorkers: readonly WorkerRecord[];
    readonly pendingWorkers: readonly PendingWorkerRecord[];
    readonly unrecordedWorkers: readonly WorkerSocket[];
    readonly settleRecovery?: () => Promise<WorkerRecordScan>;
    readonly onGlobalChangeReady: (notify: (kind: GlobalChange) => void) => void;
}

interface WorkerSlot {
    readonly id: WorkerOwner;
    readonly index: number;
    readonly socket: string;
    connected: PromiseWithResolvers<ControlPeer>;
    started: PromiseWithResolvers<void>;
    exited: PromiseWithResolvers<void>;
    readonly endpoint: SessionEndpoint;
    broker: ControlReservations;
    inbox: MasterInboxBridge;
    peer?: ControlPeer;
    supervisor?: SessionWorkerSupervisor;
    generation: number;
    ready: boolean;
    starting: boolean;
    closed: boolean;
    lastHeartbeat: number;
    failures: number[];
    recoverySessions: readonly WorkerRecoverySession[];
    reason?: string;
    spawnPid?: number;
    stopping?: Promise<void>;
    restarting?: Promise<void>;
}

export function prepareProcessWorker(options: ProcessWorkerOptions): InProcessWorker {
    const reservations = options.sessionOptions.restoringSessions ?? new Map();
    const forwardedShutdowns = new ForwardedShutdowns();
    const generations = new WorkerGenerations();
    const changes = new Set<() => void>();
    const knownSessions = new Set<string>();
    let control: WorkerControlServer | undefined;
    let closing = false;
    let initializing = true;
    const adopting = new Map(options.recoverableWorkers.map((worker) => [worker.record.index, worker]));
    const adoptedIndices = new Set(adopting.keys());
    const stoppedIndices = new Set(options.stoppedWorkers.map((worker) => worker.index));
    const pendingIndices = new Set(options.pendingWorkers.map((worker) => worker.record.index));
    const unknownSockets = new Set(options.unrecordedWorkers.map((worker) => worker.path));
    const unknownIndices = new Set(options.unrecordedWorkers.map((worker) => worker.index));
    let restoring = options.recoverableWorkers.length > 0 || options.stoppedWorkers.length > 0
        || options.pendingWorkers.length > 0 || options.unrecordedWorkers.length > 0;
    let scanning = false;
    let deferredRecovery = false;
    let recoveryFailed = false;
    const recoveryPending = (): boolean => scanning;
    const reportsPending = (): boolean => restoring && unknownSockets.size === 0;
    const ownershipUncertain = (): boolean => restoring || unknownSockets.size > 0 || deferredRecovery || recoveryFailed;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const deadline = options.hostOptions.processWorkerHeartbeatDeadlineMs ?? 10_000;
    if (!Number.isFinite(deadline) || deadline <= 0) throw new Error("Invalid worker heartbeat deadline");
    const masterGraceMs = options.hostOptions.processWorkerMasterGraceMs ?? 30_000;
    if (!Number.isFinite(masterGraceMs) || masterGraceMs <= 0) throw new Error("Invalid worker master grace");
    const makeInbox = (index: number, connection: () => Promise<ControlPeer>): MasterInboxBridge => new MasterInboxBridge(
        options.master.inboxDelivery,
        async (method, args, signal) => await (await connection()).request(`inbox.${method}`, args, signal),
        (id) => routed.router.inboxOwner(id) === `w${index}`,
    );
    const slots: WorkerSlot[] = Array.from({ length: options.workerCount }, (_, index) => {
        const connected = Promise.withResolvers<ControlPeer>();
        const exited = Promise.withResolvers<void>();
        void connected.promise.catch(() => {});
        void exited.promise.catch(() => {});
        let slot!: WorkerSlot;
        slot = {
            id: `w${index}`, index, socket: inProcessWorkerSocket(options.sessionOptions.home, index),
            connected, started: Promise.withResolvers<void>(), exited, endpoint: remoteSessionEndpoint(() => slot.connected.promise),
            broker: new ControlReservations(reservations),
            inbox: makeInbox(index, () => slot.connected.promise),
            generation: 0, ready: false, starting: true, closed: false, lastHeartbeat: performance.now(), failures: [], recoverySessions: [],
        };
        return slot;
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
        recoveryPending,
        reportsPending,
        ownershipUncertain,
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
        for (const summary of value.summaries) knownSessions.add(summary.id);
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
        ...(hostOptions.inboxPath === undefined ? {} : { inboxPath: hostOptions.inboxPath }),
        ...(hostOptions.inboxUserConfigPath === undefined ? {} : { inboxUserConfigPath: hostOptions.inboxUserConfigPath }),
        ...(hostOptions.schedulePath === undefined ? {} : { schedulePath: hostOptions.schedulePath }),
        ...(hostOptions.arcConfigPath === undefined ? {} : { arcConfigPath: hostOptions.arcConfigPath }),
    };
    const bootstrap: WorkerBootstrap = {
        options: childOptions, masterSocket: options.masterSocket, lockPath: options.lockPath,
        buildId: options.buildId, capabilities: options.capabilities,
        extensionCatalog: buildExtensionCatalog(options.master.extensions),
        heartbeatIntervalMs: Math.max(1, Math.min(1_000, Math.floor(deadline / 3))),
        masterGraceMs,
    };
    const startSlot = async (slot: WorkerSlot): Promise<void> => {
        const adopted = adopting.get(slot.index);
        adopting.delete(slot.index);
        if (stoppedIndices.has(slot.index) && adopted === undefined) generations.observe(slot.id, 1);
        const generation = adopted?.identity.worker_generation ?? generations.next(slot.id);
        if (adopted !== undefined) generations.observe(slot.id, generation);
        slot.generation = generation;
        slot.lastHeartbeat = performance.now();
        try {
            slot.supervisor = await startSessionWorkerSupervisor({
                home: options.sessionOptions.home, socket: slot.socket, bootstrap,
                control,
                ...(adopted === undefined ? {} : { adopt: adopted }),
                ...(adopted?.unrecorded === true ? { startupTimeoutMs: 2_000 } : {}),
                index: slot.index, count: slots.length, generation: slot.generation,
                onSpawn(pid) {
                    slot.spawnPid = pid;
                    if (closing) {
                        try { process.kill(pid, "SIGKILL"); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
                    }
                },
                onConnected(peer) {
                    slot.peer = peer;
                    slot.connected.resolve(peer);
                    void peer.closed.then(() => slotLost(slot, generation, "control_closed"));
                },
                onEvent(event) {
                    if (slot.generation !== generation) return;
                    if (event === "heartbeat") slot.lastHeartbeat = performance.now();
                    if (event === "roster_delta") notifyChanges();
                },
                async handler(method, args, signal) {
                    if (method.startsWith("globals.")) return await globals.handle(method, args);
                    if (method.startsWith("extension.")) {
                        return await serveExtensionRequest(options.master.extensions, method, args, signal);
                    }
                    if (method.startsWith("inbox.")) return await slot.inbox.handle(method.slice(6), args, signal);
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
                        if (recoveryPending() && method !== "router.endWorkerOpen" && method !== "router.endBranch") {
                            throw new Error("The session processes are starting.");
                        }
                        return await serveRoutedMethod(routed.router, "router", method.slice(7), args, signal);
                    }
                    if (method.startsWith("attachment.")) {
                        if (method === "attachment.restore") {
                            if (typeof args[0] !== "string" || typeof args[1] !== "string" || typeof args[2] !== "string") {
                                throw new Error("Invalid attachment lease");
                            }
                            return await routed.attachments.restore(args[0], args[1], args[2]);
                        }
                        if (recoveryPending() && method !== "attachment.abandon") throw new Error("The session processes are starting.");
                        return await serveRoutedMethod(routed.attachments, "attachment", method.slice(11), args, signal);
                    }
                    if (method === "host.findWorker" && typeof args[0] === "string") {
                        if (recoveryPending()) throw new Error("The session processes are starting.");
                        const id = args[0];
                        await routed.router.waitForImports();
                        return await routed.reserveAgent(id, async (reserved, path) => {
                            if (!await routed.router.find(slot.id, id, reserved, path)) return false;
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
            void slot.supervisor.exited.then(() => slotLost(slot, generation, "process_exited"));
            if (closing || slot.closed) throw new Error("Session worker closed before ready");
            if (generation > 1 && adopted === undefined) {
                const candidates = await Promise.all(slot.recoverySessions.map(async (session) => {
                    const heldWakes = slot.inbox.heldFor(session.id);
                    if ("baseline" in session && heldWakes.length === 0) {
                        try {
                            const current = await recoveryFileStamp(session.path);
                            if (sameRecoveryFile(session.file ?? null, current) || current === null) return undefined;
                            const snapshot = await readSessionSnapshot(session.path);
                            const last = snapshot.messages.at(-1);
                            const head = last === undefined ? null : snapshot.messageStamps.get(last)?.id ?? null;
                            if (head === session.baseline) return undefined;
                            const state = await readSessionTurnState(session.path);
                            if (!state.turnOpen && !state.needsQueueRecovery) return undefined;
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                            throw error;
                        }
                    }
                    return { id: session.id, path: session.path, heldWakes };
                }));
                const sessions = candidates.filter((session) => session !== undefined);
                await slot.supervisor.peer.request("worker.recover", [sessions], AbortSignal.timeout(30_000));
                if (slot.closed) throw new Error("Session worker closed during recovery");
            }
            slot.recoverySessions = [];
            routed.router.observe(slot.id, slot.supervisor.snapshot.residents);
            routed.router.observeStored(slot.id, slot.supervisor.snapshot.summaries);
            for (const summary of slot.supervisor.snapshot.summaries) knownSessions.add(summary.id);
            if (adopted !== undefined) {
                await requestWorker(slot, "worker.restore");
                await requestWorker(slot, "worker.activate");
            }
            if (closing || slot.closed) throw new Error("Session worker closed during activation");
            slot.ready = true;
            slot.lastHeartbeat = performance.now();
        } catch (error) {
            if (slot.supervisor !== undefined) await slot.supervisor.close();
            slot.closed = true;
            slot.inbox.close();
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
    const resetSlot = (slot: WorkerSlot): void => {
        slot.connected = Promise.withResolvers<ControlPeer>();
        slot.started = Promise.withResolvers<void>();
        slot.exited = Promise.withResolvers<void>();
        void slot.connected.promise.catch(() => {});
        void slot.exited.promise.catch(() => {});
        slot.broker = new ControlReservations(reservations);
        slot.inbox = makeInbox(slot.index, () => slot.connected.promise);
        slot.peer = undefined;
        slot.supervisor = undefined;
        slot.spawnPid = undefined;
        slot.ready = false;
        slot.starting = true;
        slot.closed = false;
    };
    const replaceSlot = async (slot: WorkerSlot, firstReason: string): Promise<void> => {
        let reason = firstReason;
        while (!closing) {
            const now = Date.now();
            slot.failures = slot.failures.filter((at) => now - at < 60_000);
            slot.failures.push(now);
            slot.reason = reason;
            if (reason === "worker_socket_busy" || slot.failures.length >= 3) {
                if (reason !== "worker_socket_busy") slot.reason = "crash_loop";
                slot.starting = false;
                notifyChanges();
                return;
            }
            resetSlot(slot);
            notifyChanges();
            try {
                await startSlot(slot);
                notifyChanges();
                return;
            } catch (error) {
                reason = error instanceof Error && error.message.includes("worker_socket_busy")
                    ? "worker_socket_busy" : "startup_failed";
            }
        }
    };
    const slotLost = (slot: WorkerSlot, generation: number, reason: string): void => {
        if (closing || slot.generation !== generation || slot.closed) return;
        slot.closed = true;
        slot.ready = false;
        slot.reason = reason;
        slot.inbox.interrupt();
        if (!slot.starting) slot.recoverySessions = routed.router.workerSessions(slot.id, slot.inbox.heldLabels());
        notifyChanges();
        if (slot.starting) return;
        slot.stopping = (async () => {
            await slot.started.promise;
            await slot.supervisor?.close();
            slot.inbox.close();
            slot.broker.close();
            routed.router.workerExited(slot.id);
            slot.exited.resolve();
            notifyChanges();
        })();
        void slot.stopping.catch((error: unknown) => slot.exited.reject(error));
        if (!initializing && !unknownSockets.has(slot.socket)) scheduleReplacement(slot, reason);
    };
    const scheduleReplacement = (slot: WorkerSlot, reason: string): void => {
        if (closing) return;
        if (slot.restarting !== undefined) {
            void slot.restarting.then(() => {
                if (!closing && slot.closed) scheduleReplacement(slot, slot.reason ?? reason);
            }).catch(() => {});
            return;
        }
        const restarting = (async () => {
            await slot.stopping;
            if (!closing) await replaceSlot(slot, reason);
        })();
        slot.restarting = restarting;
        void restarting.catch((error: unknown) => slot.exited.reject(error)).finally(() => {
            if (slot.restarting === restarting) slot.restarting = undefined;
        });
    };
    const unknownTasks = new Map<string, Promise<void>>();
    const watchUnknown = (socket: WorkerSocket): Promise<void> => {
        const existing = unknownTasks.get(socket.path);
        if (existing !== undefined) return existing;
        unknownSockets.add(socket.path);
        const task = (async () => {
            const slot = slots[socket.index];
            if (slot === undefined) {
                while (!closing && await socketOccupied(socket.path)) await Bun.sleep(100);
                if (!closing) unknownSockets.delete(socket.path);
                return;
            }
            slot.starting = false;
            slot.started.resolve();
            while (!closing) {
                const identity = await requestHostIdentity(socket.path);
                if (slot.ready && slot.supervisor !== undefined) {
                    if (identity?.pid === slot.supervisor.pid && identity.started_at === slot.supervisor.startedAt
                        && identity.role === "worker" && identity.worker_index === slot.index
                        && identity.build_id === options.buildId) {
                        unknownSockets.delete(socket.path);
                        return;
                    }
                    await Bun.sleep(100);
                    continue;
                }
                if (identity === undefined && !await socketOccupied(socket.path)) {
                    await slot.stopping;
                    stoppedIndices.add(slot.index);
                    resetSlot(slot);
                    try {
                        await startSlot(slot);
                        unknownSockets.delete(socket.path);
                        notifyChanges();
                        return;
                    } catch {
                        if (closing) return;
                    }
                } else if (identity !== undefined) {
                    const hello = {
                        id: `w${socket.index}`, index: socket.index, count: identity.worker_count ?? 0,
                        pid: identity.pid, started_at: identity.started_at,
                        build_id: identity.build_id ?? "", socket: socket.path,
                    };
                    if (hello.count === slots.length && verifiedWorkerHello({ ...socket, identity }, hello, options.buildId)) {
                        await slot.stopping;
                        resetSlot(slot);
                        const record: WorkerRecord = {
                            id: hello.id, index: hello.index, pid: hello.pid, started_at: hello.started_at,
                            socket_path: hello.socket, control_path: control!.path, build_id: hello.build_id,
                            master_pid: process.pid, count: hello.count,
                        };
                        adopting.set(slot.index, { record, identity, unrecorded: true });
                        try {
                            await startSlot(slot);
                            adoptedIndices.add(slot.index);
                            unknownSockets.delete(socket.path);
                            notifyChanges();
                            return;
                        } catch {
                            if (slot.supervisor !== undefined) await slot.supervisor.close();
                            await slot.stopping;
                            if (closing) return;
                        }
                    }
                }
                await Bun.sleep(100);
            }
        })();
        unknownTasks.set(socket.path, task);
        void task.finally(() => {
            if (unknownTasks.get(socket.path) === task) unknownTasks.delete(socket.path);
        }).catch(() => {});
        return task;
    };
    const accounted = (socket: WorkerSocket): boolean => {
        const slot = slots[socket.index];
        return slot?.ready === true && slot.supervisor !== undefined && socket.identity?.pid === slot.supervisor.pid
            && socket.identity.started_at === slot.supervisor.startedAt && socket.identity.role === "worker"
            && socket.identity.worker_index === slot.index && socket.identity.build_id === options.buildId;
    };
    let recoveryWork: Promise<void> | undefined;
    const finishRecovery = async (): Promise<void> => {
        while (!closing) {
            const sockets = await occupiedWorkerSockets(options.sessionOptions.home, slots.length);
            const unknown = sockets.filter((socket) => !accounted(socket));
            if (unknown.length > 0) {
                await Promise.all(unknown.map((socket) => watchUnknown(socket)));
                continue;
            }
            scanning = true;
            try {
                await routed.router.waitForOpenings();
                const rechecked = await occupiedWorkerSockets(options.sessionOptions.home, slots.length);
                if (rechecked.some((socket) => !accounted(socket))) continue;
                const replacements = slots.filter((slot) => slot.ready && stoppedIndices.has(slot.index));
                if (replacements.length !== stoppedIndices.size) throw new Error("A session process could not be replaced");
                if (replacements.length === 0) return;
                const snapshots = await Promise.all(slots.filter((slot) => slot.ready)
                    .map((slot) => requestWorker<import("./session-endpoint.ts").SessionSnapshot>(slot, "session.snapshot")));
                const residents = snapshots.flatMap((snapshot) => snapshot.residents);
                await Promise.all(replacements.map((slot, index) => slot.peer!.request("worker.recoverUnowned",
                    [residents, index, replacements.length], AbortSignal.timeout(30_000))));
                return;
            } finally {
                scanning = false;
            }
        }
    };
    return {
        masterHandlers: routed.masterHandlers,
        async start() {
            control = await startWorkerControlServer(options.sessionOptions.home);
            const recovering = restoring;
            const settled = options.pendingWorkers.length === 0 ? Promise.resolve() : (async () => {
                if (options.settleRecovery === undefined) throw new Error("Session process recovery is unavailable");
                const scan = await options.settleRecovery();
                if (scan.count !== undefined && scan.count !== slots.length) throw new Error("Session processes disagree on the pool size");
                for (const worker of scan.recoverable) {
                    if (adoptedIndices.has(worker.record.index)) continue;
                    adopting.set(worker.record.index, worker);
                    adoptedIndices.add(worker.record.index);
                }
                for (const worker of scan.stopped) stoppedIndices.add(worker.index);
            })();
            void settled.catch(() => {});
            for (const socket of options.unrecordedWorkers) void watchUnknown(socket).catch(() => {});
            const results = await Promise.allSettled(slots.map(async (slot) => {
                if (unknownIndices.has(slot.index)) return;
                if (pendingIndices.has(slot.index)) await settled;
                await startSlot(slot);
            }));
            await settled;
            if (recovering) {
                for (const [index, result] of results.entries()) {
                    if ((adoptedIndices.has(index) || stoppedIndices.has(index)) && result.status === "rejected") throw result.reason;
                }
            }
            initializing = false;
            for (const [index, slot] of slots.entries()) {
                if (slot.ready || unknownSockets.has(slot.socket)) continue;
                const result = results[index];
                const error = result?.status === "rejected" ? result.reason : undefined;
                const reason = error instanceof Error && error.message.includes("worker_socket_busy")
                    ? "worker_socket_busy" : slot.reason ?? "startup_failed";
                scheduleReplacement(slot, reason);
            }
            heartbeatTimer = setInterval(() => {
                const now = performance.now();
                for (const slot of slots) {
                    if (!slot.ready || now - slot.lastHeartbeat < deadline) continue;
                    const supervisor = slot.supervisor;
                    slotLost(slot, slot.generation, "heartbeat_timeout");
                    supervisor?.kill();
                }
            }, Math.max(1, Math.min(250, Math.floor(deadline / 4))));
            heartbeatTimer.unref();
            if (recovering && unknownSockets.size > 0) {
                deferredRecovery = true;
                restoring = false;
                recoveryWork = finishRecovery().then(() => { deferredRecovery = false; }, (error: unknown) => {
                    recoveryFailed = true;
                    options.hostOptions.startupLog?.({
                        type: "session_process_recovery_failed",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            } else if (recovering) {
                await finishRecovery();
                restoring = false;
            }
            routed.snapshots.refresh();
            await routed.snapshots.wait();
        },
        workerHealth: () => slots.map((slot) => ({
            id: slot.id, index: slot.index, generation: slot.generation,
            ...(slot.supervisor === undefined || slot.closed ? {} : { pid: slot.supervisor.pid }),
            state: slot.ready ? slot.reason === undefined ? "ready" as const : "replaced" as const
                : slot.starting ? "starting" as const : "unavailable" as const,
            ...(slot.reason === undefined ? {} : { reason: slot.reason }),
        })),
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
        async notifyAnnexChanged(url) {
            await Promise.all(slots.filter((slot) => slot.ready)
                .map((slot) => requestWorker(slot, "worker.annexChanged", [url])));
        },
        flushStores: () => routed.router.flush(),
        async knowsSession(id) {
            while (true) {
                const owner = routed.router.inboxOwner(id);
                if (owner === "host") return (await options.master.handlers.listAgents()).some((session) => session.id === id);
                const slot = slots.find((candidate) => candidate.id === owner);
                if (slot === undefined) return false;
                if (slot.starting && slot.generation > 1) return knownSessions.has(id) || routed.router.knownPath(id) !== undefined;
                if (slot.starting) await slot.started.promise;
                if (routed.router.inboxOwner(id) !== owner) continue;
                if (!slot.ready) return knownSessions.has(id) || routed.router.knownPath(id) !== undefined;
                try {
                    const sessions = await slot.endpoint.list();
                    for (const session of sessions) knownSessions.add(session.id);
                    return sessions.some((session) => session.id === id) || knownSessions.has(id);
                } catch (error) {
                    if (slot.closed) return knownSessions.has(id) || routed.router.knownPath(id) !== undefined;
                    throw error;
                }
            }
        },
        waitForForwardedShutdowns: () => forwardedShutdowns.wait(),
        async close() {
            closing = true;
            if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
            for (const slot of slots) {
                slot.ready = false;
                if (slot.starting && slot.supervisor === undefined && slot.spawnPid !== undefined) {
                    try { process.kill(slot.spawnPid, "SIGKILL"); }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
                }
            }
            stopSnapshots();
            routed.close();
            await Promise.allSettled([...unknownTasks.values()]);
            await recoveryWork;
            const results = await Promise.allSettled(slots.map(async (slot) => {
                if (slot.supervisor === undefined && slot.starting) await slot.started.promise;
                if (slot.supervisor !== undefined) await slot.supervisor.close();
                else slot.connected.reject(new Error("Session worker was not started"));
                await slot.stopping;
                await slot.restarting;
                slot.inbox.close();
                slot.broker.close();
            }));
            await control?.close();
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
        },
    };
}
