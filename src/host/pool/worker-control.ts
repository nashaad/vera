import type { HostIdentity } from "../protocol.ts";
import { HostConnectionClosedError } from "../connection.ts";
import { HostSocketHeldError, startWorkerServer, type HostListener, type StartHostServerOptions } from "../server.ts";
import { startSessionWorkerRuntime, type StartResidentHostOptions } from "../runtime.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import { EMPTY_WORK_INDEX, type WorkIndexSnapshot } from "../work-index.ts";
import type { RegisteredAgentSummary } from "../agent-registry.ts";
import type { ControlChannel } from "./control.ts";
import type { WorkerControlLink } from "./worker-link.ts";
import { remoteRouter } from "./remote-routing.ts";
import { WorkerAttachments } from "./worker-attachments.ts";
import { remoteReservations } from "./reservations.ts";
import { serveSessionEndpoint } from "./remote-endpoint.ts";
import { sessionTarget } from "./routing.ts";
import { createPublicForwarder } from "./public-forward.ts";
import { defaultPermissionPreferencesPath } from "../../engine/permission-preferences.ts";
import { createLiveVeraConfigReader, defaultVeraConfigPath } from "../../config.ts";
import { WorkerGlobals } from "./worker-globals.ts";
import type { GlobalChange } from "./global-services.ts";
import { applyConfigDefaults } from "./config-defaults.ts";
import { remoteExtensions, type ExtensionCatalog } from "./extension-catalog.ts";
import { WorkerInboxBridge } from "./inbox.ts";
import { recoverUnownedSessions } from "./recovery-scan.ts";
import { discoverCrashSession, recoverCrashSession, type CrashSessionPath } from "./worker-crash-scan.ts";
import { prepareWorkerExit } from "./worker-exit.ts";
import { removeOwnWorkerRecord } from "./worker-record.ts";
import { indexStoredSession, withSessionReservation } from "../session-host/storage.ts";
import { SessionStore } from "../../store/session-store.ts";
import type { StopWaitEvent } from "../stop-when-idle.ts";
import { StopWaitRelay } from "./stop-wait-relay.ts";

export type WorkerStartOptions = Pick<StartResidentHostOptions,
    "config" | "home" | "configPath" | "projectRoot" | "sessionDirectory" | "blockedDirectory"
    | "permissionPreferencesPath" | "eventLogDirectory" | "modelFailureLedgerPath" | "importRoots"
    | "inboxPath" | "inboxUserConfigPath" | "schedulePath" | "arcConfigPath"
>;

export interface WorkerBootstrap {
    readonly options: WorkerStartOptions;
    readonly hostSocket: string;
    readonly lockPath: string;
    readonly buildId: string;
    readonly capabilities: readonly string[];
    readonly extensionCatalog: ExtensionCatalog;
    readonly heartbeatIntervalMs?: number;
    readonly turnsHeld?: boolean;
    readonly hostGraceMs?: number;
    readonly adopt?: true;
}

export interface WorkerHello {
    readonly id: string;
    readonly index: number;
    readonly count: number;
    readonly pid: number;
    readonly started_at: string;
    readonly build_id: string;
    readonly socket: string;
}

export const COMMON_METHODS = [
    "locateAgent", "createAgent", "resumeAgent", "listAgents", "renameSession", "trashSession",
    "closeAgent", "blockSession", "unblockSession", "syncAgentContext", "readSessionFacts",
    "searchSessions", "importSession", "listImportableSessions",
] as const;

type RemoteCommon = Pick<StartHostServerOptions, typeof COMMON_METHODS[number]>;

function remoteCommon(peer: ControlChannel): RemoteCommon {
    const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of COMMON_METHODS) {
        methods[method] = (...args) => peer.request(`host.${method}`, args);
    }
    return methods as unknown as RemoteCommon;
}

export async function startControlledWorker(
    peer: WorkerControlLink, bootstrap: WorkerBootstrap, hello: WorkerHello, generation: number, onShutdown: () => void,
): Promise<{ adopt(signal: AbortSignal, heartbeatIntervalMs?: number): Promise<void>; close(hostLost?: boolean): Promise<void> }> {
    const home = bootstrap.options.home;
    if (home === undefined) throw new Error("Worker home is unavailable");
    const globals = new WorkerGlobals(peer, home,
        bootstrap.options.configPath ?? defaultVeraConfigPath(home),
        bootstrap.options.permissionPreferencesPath ?? defaultPermissionPreferencesPath(home));
    const pendingChanges: GlobalChange[] = [];
    const stopWait = new StopWaitRelay();
    let turnsHeld = bootstrap.turnsHeld === true;
    peer.setEventHandler((event, value) => {
        if (event === "shutdown") onShutdown();
        else if (event === "config_changed" && isGlobalChange(value)) pendingChanges.push(value);
    });
    await globals.initialize();
    const reservations = remoteReservations(peer);
    const runtime = await startSessionWorkerRuntime(bootstrap.options, reservations, {
        index: hello.index, count: hello.count,
    }, globals, remoteExtensions(peer, bootstrap.extensionCatalog), () => turnsHeld);
    const host = runtime.sessionHost;
    const currentConfig = createLiveVeraConfigReader(bootstrap.options.config, {
        path: bootstrap.options.configPath ?? defaultVeraConfigPath(home),
    });
    const reloadDefaults = (): void => applyConfigDefaults(host.registry, currentConfig());
    const endpoint = sessionEndpoint(host);
    const router = remoteRouter(peer);
    const attachments = new WorkerAttachments(peer);
    const publicForwarder = createPublicForwarder(peer);
    const inbox = new WorkerInboxBridge((method, args, signal) => peer.request(`inbox.${method}`, args, signal));
    const listeners = new Set<() => void>();
    let summaries: readonly RegisteredAgentSummary[] = [];
    let workIndex: WorkIndexSnapshot = EMPTY_WORK_INDEX;
    let server: HostListener | undefined;
    host.setExtensionSessions(router);
    host.registry.peerSessions = router;
    host.registry.subagentSessions = router;
    host.registry.subagentAdmission = router;
    host.inboxDelivery.setSessionBridge(inbox);
    const heldWakes = new Map<string, ReadonlySet<number>>();
    host.registry.shouldWakeStoredDelivery = (id, delivery) => {
        const held = heldWakes.get(id);
        if (held === undefined) return true;
        const extensionSeq = delivery.sourceKind === "extension" && /^inbox:\d+$/.test(delivery.id)
            ? Number(delivery.id.slice(6)) : undefined;
        const seq = delivery.peer?.messageId ?? extensionSeq;
        return seq === undefined || !held.has(seq);
    };
    const opening = new Set<string>();
    host.registry.openGuard = {
        async beginCreate(id, path, parentId) {
            if (!peer.connected) throw new HostConnectionClosedError(false);
            if (opening.has(id)) throw new Error(`Resident agent ${id} is starting`);
            if (parentId === undefined) return;
            await router.beginWorkerCreate(hello.id as `w${number}`, id, path, parentId);
            opening.add(id);
        },
        async beginResume(path) {
            if (!peer.connected) throw new HostConnectionClosedError(false);
            const { id } = await readSessionHeader(path);
            if (opening.has(id)) throw new Error(`Resident agent ${id} is starting`);
            return id;
        },
        end(id) {
            if (opening.delete(id)) void peer.request("router.endWorkerOpen", [id]).catch(() => {});
        },
    };
    host.inboxDelivery.setExternalPump((seq) => router.pumpInbox(hello.id as `w${number}`, seq));
    host.handlers.setImportedSourceHash((summary) => router.importedSourceHash(summary));
    const activeRequests = new Set<Promise<unknown>>();
    const handleRequest = async (method: string, args: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
        if (method.startsWith("inbox.")) return await inbox.handle(method.slice(6), args, signal);
        if (method === "public.frame") return await publicForwarder.receiveFrame(args);
        if (method.startsWith("session.")) {
            reloadDefaults();
            return await serveSessionEndpoint(endpoint, method.slice(8), args, signal);
        }
        if (method === "worker.canShutdown") return host.handlers.canShutdown();
        if (method === "worker.canReplace") return host.handlers.canReplace();
        if (method === "worker.setTurnsHeld" && typeof args[0] === "boolean") {
            turnsHeld = args[0];
            return;
        }
        if (method === "worker.stopWaitEvent") {
            await stopWait.publish(args[0] as StopWaitEvent);
            return;
        }
        if (method === "worker.discoverCrashSessions") {
            const paths = args[0];
            if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
                throw new Error("Invalid crash session paths");
            }
            const sessions: CrashSessionPath[] = [];
            for (const path of paths) {
                signal.throwIfAborted();
                const session = await discoverCrashSession(path);
                if (session !== undefined) sessions.push(session);
            }
            return sessions;
        }
        if (method === "worker.recoverCrashSession") {
            const session = args[0] as CrashSessionPath | undefined;
            if (typeof session !== "object" || session === null || typeof session.path !== "string"
                || typeof session.id !== "string" || session.id.length === 0) {
                throw new Error("Invalid crash session");
            }
            return await recoverCrashSession({
                session, registry: host.registry, reservations, signal,
                owns: (id) => peer.request<boolean>("recovery.owns", [id], signal),
                record: (id) => peer.request<void>("recovery.recordCrash", [id], signal),
            });
        }
        if (method === "worker.recoverUnowned") {
            const [residents, index, count] = args;
            if (!Array.isArray(residents) || !residents.every((entry) => typeof entry === "object" && entry !== null
                && typeof entry.id === "string" && typeof entry.sessionPath === "string")
                || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || (index as number) < 0
                || (count as number) <= (index as number)) throw new Error("Invalid session recovery request");
            await recoverUnownedSessions({ home, directory: bootstrap.options.sessionDirectory, reservations,
                residents, index: index as number, count: count as number,
                remember: (summary) => host.handlers.rememberStored(summary) });
            return;
        }
        if (method === "worker.restore") {
            await attachments.restore();
            await inbox.restore();
            return;
        }
        if (method === "worker.activate") {
            peer.activate();
            await inbox.activate();
            return;
        }
        if (method === "worker.hasSession") {
            const id = args[0];
            return typeof id === "string" && (host.registry.agents.has(id)
                || host.registry.startingIds.has(id) || host.registry.trashingIds.has(id));
        }
        if (method === "worker.clearProviderSelection" && typeof args[0] === "string") {
            await host.clearProviderSelection(args[0]);
            return;
        }
        if (method === "worker.catalogChanged") {
            host.registry.notifyModelCatalogChanged();
            return;
        }
        if (method === "worker.annexChanged") {
            runtime.setAnnexUrl(typeof args[0] === "string" ? args[0] : undefined);
            return;
        }
        if (method === "worker.stopMaintenance") {
            host.stopMaintenance();
            return;
        }
        if (method === "worker.recover") {
            const sessions = args[0];
            if (!Array.isArray(sessions) || !sessions.every((entry) =>
                typeof entry === "object" && entry !== null && typeof entry.id === "string" && typeof entry.path === "string"
                && Array.isArray(entry.heldWakes) && entry.heldWakes.every((seq: unknown) =>
                    Number.isSafeInteger(seq) && (seq as number) > 0))) {
                throw new Error("Invalid worker recovery sessions");
            }
            for (const session of sessions as Array<{ id: string; path: string; heldWakes: number[] }>) {
                if (session.heldWakes.length > 0) heldWakes.set(session.id, new Set(session.heldWakes));
                try {
                    await withSessionReservation(session.path, reservations, async (path) => {
                        const store = await SessionStore.open(path);
                        if (store.header.id !== session.id) throw new Error("Worker recovery session identity changed");
                        await store.repairCrashedTurn({ workerExited: true });
                        const indexed = new Map<string, RegisteredAgentSummary>();
                        await indexStoredSession(path, indexed);
                        const summary = indexed.get(session.id);
                        if (summary !== undefined) host.handlers.rememberStored(summary);
                    });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
            return;
        }
        throw new Error("Unknown worker control request");
    };
    peer.setHandler((method, args, signal) => {
        const request = handleRequest(method, args, signal);
        activeRequests.add(request);
        return request.finally(() => activeRequests.delete(request));
    });
    const applyChange = (kind: GlobalChange): void => {
        if (kind === "config") reloadDefaults();
        const reloadCatalog = globals.hasCatalog();
        void globals.changed(kind).then(async () => {
            if (kind !== "preferences" && reloadCatalog) await globals.ensureCatalog();
            host.registry.notifyModelCatalogChanged();
            host.registry.pushWorkerStateEverywhere();
        }).catch(() => {});
    };
    peer.setEventHandler((event, value) => {
        if (event === "shutdown") {
            onShutdown();
            return;
        }
        if (event === "config_changed" && isGlobalChange(value)) {
            applyChange(value);
            return;
        }
        if (event !== "snapshot" || typeof value !== "object" || value === null) return;
        const snapshot = value as { summaries?: unknown; workIndex?: unknown };
        if (Array.isArray(snapshot.summaries)) summaries = snapshot.summaries as RegisteredAgentSummary[];
        if (typeof snapshot.workIndex === "object" && snapshot.workIndex !== null) workIndex = snapshot.workIndex as WorkIndexSnapshot;
        for (const listener of listeners) listener();
    });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const setHeartbeat = (interval: number | undefined): void => {
        const delay = interval ?? 1_000;
        if (!Number.isFinite(delay) || delay <= 0) throw new Error("Invalid session process heartbeat interval");
        if (heartbeat !== undefined) clearInterval(heartbeat);
        let previousHeartbeat = performance.now();
        heartbeat = setInterval(() => {
            const now = performance.now();
            const eventLoopLagMs = Math.max(0, now - previousHeartbeat - delay);
            previousHeartbeat = now;
            void peer.event("heartbeat", {
                rss_bytes: process.memoryUsage().rss,
                event_loop_lag_ms: eventLoopLagMs,
            }).catch(() => {});
        }, delay);
        heartbeat.unref();
    };
    setHeartbeat(bootstrap.heartbeatIntervalMs);
    for (const kind of pendingChanges) applyChange(kind);
    let rosterTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRoster = 0;
    const publishRoster = (): void => {
        rosterTimer = undefined;
        lastRoster = Date.now();
        void peer.event("roster_delta").catch(() => {});
    };
    const stopRosterListener = host.handlers.onRosterChanged(() => {
        if (rosterTimer !== undefined) return;
        const delay = Math.max(0, 1_000 - (Date.now() - lastRoster));
        if (delay === 0) publishRoster();
        else rosterTimer = setTimeout(publishRoster, delay);
    });
    const stopTracking = (): void => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        stopRosterListener();
        if (rosterTimer !== undefined) clearTimeout(rosterTimer);
    };
    try {
        server = await startWorkerServer({
            ...host.handlers,
            ...remoteCommon(peer),
            socketPath: hello.socket,
            lockPath: bootstrap.lockPath,
            buildId: hello.build_id,
            capabilities: bootstrap.capabilities,
            pid: hello.pid,
            startedAt: hello.started_at,
            attachmentCoordinator: attachments,
            forwardHostRequest: publicForwarder.forward,
            stopWaitObserver: stopWait,
            onRosterChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            listBackgroundAgents: () => summaries,
            readWorkIndex: () => workIndex,
            findAgent: async (id) => await peer.request<boolean>("host.findWorker", [id])
                ? host.registry.find(id) : undefined,
            branchAgent: async (request) => {
                if (!await router.beginBranch(hello.id as `w${number}`, request.sourceId)) return undefined;
                const id = request.id ?? randomUUID();
                let opened = false;
                try {
                    const path = request.sessionPath ?? (request.ephemeral === true ? undefined : host.registry.options.sessionPathForId?.(id));
                    await router.beginWorkerCreate(hello.id as `w${number}`, id, path);
                    opened = true;
                    return await host.handlers.branchAgent({ ...request, id });
                } finally {
                    if (opened) await router.endWorkerOpen(id);
                    await router.endBranch(request.sourceId);
                }
            },
            routeRequest: (request) => {
                const target = sessionTarget(request);
                return target === undefined ? Promise.resolve(undefined) : router.socketFor(hello.id as `w${number}`, target);
            },
            canShutdown: () => false,
            canReplace: () => false,
        }, { id: hello.id, index: hello.index, count: hello.count, generation });
        await peer.request("ready", [await endpoint.snapshot()]);
    } catch (error) {
        stopTracking();
        await server?.close();
        await runtime.close();
        if (error instanceof HostSocketHeldError) throw new Error("worker_socket_busy");
        throw error;
    }
    let closing: Promise<void> | undefined;
    return {
        async adopt(signal, heartbeatIntervalMs) {
            setHeartbeat(heartbeatIntervalMs);
            while (activeRequests.size > 0 || host.registry.startingIds.size > 0 || opening.size > 0) {
                signal.throwIfAborted();
                await Bun.sleep(10);
            }
            signal.throwIfAborted();
            turnsHeld = false;
            void stopWait.abandon().catch(() => {});
            await peer.request("ready", [await endpoint.snapshot()], signal);
            applyChange("config");
            applyChange("auth");
            applyChange("preferences");
        },
        close(hostLost = false) {
            if (closing === undefined) {
                closing = (async () => {
                    stopTracking();
                    const cutStores: SessionStore[] = [];
                    if (hostLost) {
                        for (const target of host.registry.stopWaitTargets()) {
                            const entry = host.registry.agents.get(target.session_id);
                            if (entry !== undefined) {
                                cutStores.push(entry.store);
                                prepareWorkerExit(entry.store);
                                entry.agent.abort();
                            }
                        }
                        const deadline = performance.now() + 1_500;
                        while (host.registry.stopWaitTargets().length > 0 && performance.now() < deadline) await Bun.sleep(10);
                    }
                    try { await server?.close(); }
                    finally {
                        try { await runtime.close(); }
                        finally {
                            if (hostLost) {
                                for (const store of cutStores) {
                                    await store.exclusively(async () => {});
                                    await store.repairCrashedTurn({ workerExited: true });
                                }
                                await removeOwnWorkerRecord(home, hello);
                            }
                        }
                    }
                })();
            }
            return closing;
        },
    };
}

export type WorkerIdentity = Pick<HostIdentity, "pid" | "started_at">;
function isGlobalChange(value: unknown): value is GlobalChange {
    return value === "auth" || value === "config" || value === "pool"
        || value === "preferences" || value === "catalog";
}
import { randomUUID } from "node:crypto";
import { readSessionHeader } from "../../store/session-store.ts";
