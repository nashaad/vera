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
import { stopWorkerProcess, type WorkerStopIdentity } from "./stop-worker.ts";
import { checkRecordIdentity, processIsAlive } from "../process-identity.ts";
import type { StopWaitEvent } from "../stop-when-idle.ts";

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
    rssBytes?: number;
    eventLoopLagMs?: number;
    failures: number[];
    recoverySessions: readonly WorkerRecoverySession[];
    reason?: string;
    spawnPid?: number;
    spawnIdentity?: WorkerStopIdentity;
    spawnStop?: Promise<void>;
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
    let turnsHeld = false;
    let stopWaitVersion = 0;
    let stopWaitState: Extract<StopWaitEvent, { type: "wait" | "wait_cleared" }> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const deadline = options.hostOptions.processWorkerHeartbeatDeadlineMs ?? 10_000;
    if (!Number.isFinite(deadline) || deadline <= 0) throw new Error("Invalid worker heartbeat deadline");
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
        pid: () => slot.supervisor?.pid ?? slot.spawnPid,
        canShutdown: async () => slot.ready && await requestWorker<boolean>(slot, "worker.canShutdown"),
        canReplace: async () => slot.ready && await requestWorker<boolean>(slot, "worker.canReplace"),
    });
    const first = slots[0]!;
    const routed = prepareRoutedHost({
        master: options.master, worker: first.endpoint, masterSocket: options.masterSocket,
        workerSocket: first.socket, buildId: options.buildId, reservations,
        workerGeneration: () => first.generation,
        workerReady: () => first.ready,
        workerPid: () => first.supervisor?.pid ?? first.spawnPid,
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
        get turnsHeld() { return turnsHeld; },
    };
    const startSlot = async (slot: WorkerSlot): Promise<void> => {
        const generation = generations.next(slot.id);
        slot.generation = generation;
        slot.lastHeartbeat = performance.now();
        try {
            slot.supervisor = await startSessionWorkerSupervisor({
                home: options.sessionOptions.home, socket: slot.socket, bootstrap,
                control,
                index: slot.index, count: slots.length, generation: slot.generation,
                onSpawn(pid, startedAt) {
                    slot.spawnPid = pid;
                    slot.spawnIdentity = { pid, started_at: startedAt ?? new Date().toISOString() };
                    if (closing) {
                        slot.spawnStop = stopWorkerProcess(slot.spawnIdentity);
                        void slot.spawnStop.catch(() => {});
                    }
                },
                onConnected(peer) {
                    slot.peer = peer;
                    slot.connected.resolve(peer);
                    void peer.closed.then(() => slotLost(slot, generation, "control_closed"));
                },
                onEvent(event, value) {
                    if (slot.generation !== generation) return;
                    if (event === "heartbeat") {
                        slot.lastHeartbeat = performance.now();
                        if (typeof value === "object" && value !== null) {
                            const metrics = value as Record<string, unknown>;
                            if (typeof metrics.rss_bytes === "number" && Number.isFinite(metrics.rss_bytes) && metrics.rss_bytes >= 0) {
                                slot.rssBytes = metrics.rss_bytes;
                            }
                            if (typeof metrics.event_loop_lag_ms === "number" && Number.isFinite(metrics.event_loop_lag_ms)
                                && metrics.event_loop_lag_ms >= 0) slot.eventLoopLagMs = metrics.event_loop_lag_ms;
                        }
                    }
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
                        return await serveRoutedMethod(routed.router, "router", method.slice(7), args, signal);
                    }
                    if (method.startsWith("attachment.")) {
                        return await serveRoutedMethod(routed.attachments, "attachment", method.slice(11), args, signal);
                    }
                    if (method === "host.findWorker" && typeof args[0] === "string") {
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
            if (generation > 1) {
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
            await slot.supervisor.peer.request("worker.setTurnsHeld", [turnsHeld], AbortSignal.timeout(5_000));
            if (slot.closed) throw new Error("Session process closed during recovery");
            while (true) {
                const version = stopWaitVersion;
                const state = stopWaitState;
                if (state !== undefined) await requestWorker(slot, "worker.stopWaitEvent", [state]);
                if (version === stopWaitVersion) break;
            }
            slot.ready = true;
            slot.lastHeartbeat = performance.now();
            routed.router.observe(slot.id, slot.supervisor.snapshot.residents);
            routed.router.observeStored(slot.id, slot.supervisor.snapshot.summaries);
            for (const summary of slot.supervisor.snapshot.summaries) knownSessions.add(summary.id);
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
        slot.spawnIdentity = undefined;
        slot.spawnStop = undefined;
        slot.rssBytes = undefined;
        slot.eventLoopLagMs = undefined;
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
        if (!initializing) scheduleReplacement(slot, reason);
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
    return {
        masterHandlers: routed.masterHandlers,
        async start() {
            control = await startWorkerControlServer(options.sessionOptions.home);
            const results = await Promise.allSettled(slots.map(startSlot));
            initializing = false;
            for (const [index, slot] of slots.entries()) {
                if (slot.ready) continue;
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
                    try { supervisor?.kill(); } catch {}
                }
            }, Math.max(1, Math.min(250, Math.floor(deadline / 4))));
            heartbeatTimer.unref();
            routed.snapshots.refresh();
            await routed.snapshots.wait();
        },
        workerHealth: () => slots.map((slot) => ({
            id: slot.id, index: slot.index, generation: slot.generation,
            ...(slot.supervisor === undefined || slot.closed ? {} : { pid: slot.supervisor.pid }),
            state: slot.ready ? slot.reason === undefined ? "ready" as const : "replaced" as const
                : slot.starting ? "starting" as const : "unavailable" as const,
            ...(slot.reason === undefined ? {} : { reason: slot.reason }),
            ...(slot.rssBytes === undefined ? {} : { rss_bytes: slot.rssBytes }),
            ...(slot.eventLoopLagMs === undefined ? {} : { event_loop_lag_ms: slot.eventLoopLagMs }),
        })),
        stopPids: () => slots.flatMap((slot) => {
            const identity = slot.spawnIdentity;
            if (identity === undefined || !processIsAlive(identity.pid)) return [];
            return checkRecordIdentity(identity) === "mismatch" ? [] : [identity.pid];
        }),
        stopMaintenance() {
            for (const slot of slots) if (slot.ready) void requestWorker(slot, "worker.stopMaintenance").catch(() => {});
        },
        async setTurnsHeld(held) {
            turnsHeld = held;
            await Promise.all(slots.map(async (slot) => {
                if (slot.starting && !slot.closed) await slot.started.promise;
                if (slot.ready && !slot.closed) await requestWorker(slot, "worker.setTurnsHeld", [held]);
            }));
        },
        async publishStopWait(event) {
            if (event.type === "wait" || event.type === "wait_cleared") {
                stopWaitState = event;
                stopWaitVersion += 1;
            }
            await Promise.all(slots.map(async (slot) => {
                if (!slot.ready || slot.closed) return;
                const peer = slot.peer;
                try {
                    await requestWorker(slot, "worker.stopWaitEvent", [event]);
                } catch (error) {
                    if (!slot.closed && slot.peer === peer) throw error;
                }
            }));
        },
        async waitingOn() {
            const workers = await Promise.all(slots.map(async (slot) => {
                const exited = slot.exited.promise;
                if (!slot.ready) {
                    if (slot.closed) await exited;
                    return [];
                }
                try {
                    return await slot.endpoint.stopWaitTargets();
                } catch (error) {
                    if (!slot.closed) throw error;
                    await exited;
                    return [];
                }
            }));
            return [...options.master.registry.stopWaitTargets(), ...workers.flat()];
        },
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
                if (slot.starting && slot.supervisor === undefined && slot.spawnIdentity !== undefined) {
                    slot.spawnStop ??= stopWorkerProcess(slot.spawnIdentity);
                    void slot.spawnStop.catch(() => {});
                }
            }
            stopSnapshots();
            routed.close();
            const results = await Promise.allSettled(slots.map(async (slot) => {
                await slot.spawnStop;
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
