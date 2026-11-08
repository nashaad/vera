import type { HostIdentity } from "../protocol.ts";
import { startWorkerServer, type HostListener, type StartHostServerOptions } from "../server.ts";
import { startSessionWorkerRuntime, type StartResidentHostOptions } from "../runtime.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import { EMPTY_WORK_INDEX, type WorkIndexSnapshot } from "../work-index.ts";
import type { RegisteredAgentSummary } from "../agent-registry.ts";
import type { ControlPeer } from "./control.ts";
import { remoteAttachments, remoteRouter } from "./remote-routing.ts";
import { remoteReservations } from "./reservations.ts";
import { serveSessionEndpoint } from "./remote-endpoint.ts";
import { sessionTarget } from "./routing.ts";
import { createPublicForwarder } from "./public-forward.ts";
import { remoteExtensions, type ExtensionCatalog } from "./extension-catalog.ts";
import { WorkerInboxBridge } from "./inbox.ts";

export type WorkerStartOptions = Pick<StartResidentHostOptions,
    "config" | "home" | "configPath" | "projectRoot" | "sessionDirectory" | "blockedDirectory"
    | "permissionPreferencesPath" | "eventLogDirectory" | "modelFailureLedgerPath" | "importRoots"
    | "inboxPath" | "inboxUserConfigPath" | "schedulePath" | "arcConfigPath"
>;

export interface WorkerBootstrap {
    readonly options: WorkerStartOptions;
    readonly masterSocket: string;
    readonly lockPath: string;
    readonly buildId: string;
    readonly capabilities: readonly string[];
    readonly extensionCatalog: ExtensionCatalog;
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

function remoteCommon(peer: ControlPeer): RemoteCommon {
    const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of COMMON_METHODS) {
        methods[method] = (...args) => peer.request(`host.${method}`, args);
    }
    return methods as unknown as RemoteCommon;
}

export async function startControlledWorker(
    peer: ControlPeer, bootstrap: WorkerBootstrap, hello: WorkerHello, generation: number, onShutdown: () => void,
): Promise<{ close(): Promise<void> }> {
    const runtime = await startSessionWorkerRuntime(bootstrap.options, remoteReservations(peer), {
        index: hello.index, count: hello.count,
    }, remoteExtensions(peer, bootstrap.extensionCatalog));
    const host = runtime.sessionHost;
    const endpoint = sessionEndpoint(host);
    const router = remoteRouter(peer);
    const attachments = remoteAttachments(peer);
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
    const opening = new Set<string>();
    host.registry.openGuard = {
        async beginCreate(id, path, parentId) {
            if (opening.has(id)) throw new Error(`Resident agent ${id} is starting`);
            if (parentId === undefined) return;
            await router.beginWorkerCreate(hello.id as `w${number}`, id, path, parentId);
            opening.add(id);
        },
        async beginResume(path) {
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
    peer.setHandler(async (method, args, signal) => {
        if (method.startsWith("inbox.")) return await inbox.handle(method.slice(6), args, signal);
        if (method === "public.frame") return await publicForwarder.receiveFrame(args);
        if (method.startsWith("session.")) return await serveSessionEndpoint(endpoint, method.slice(8), args, signal);
        if (method === "worker.canShutdown") return host.handlers.canShutdown();
        if (method === "worker.canReplace") return host.handlers.canReplace();
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
        throw new Error("Unknown worker control request");
    });
    peer.setEventHandler((event, value) => {
        if (event === "shutdown") {
            onShutdown();
            return;
        }
        if (event !== "snapshot" || typeof value !== "object" || value === null) return;
        const snapshot = value as { summaries?: unknown; workIndex?: unknown };
        if (Array.isArray(snapshot.summaries)) summaries = snapshot.summaries as RegisteredAgentSummary[];
        if (typeof snapshot.workIndex === "object" && snapshot.workIndex !== null) workIndex = snapshot.workIndex as WorkIndexSnapshot;
        for (const listener of listeners) listener();
    });
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
            forwardMasterRequest: publicForwarder.forward,
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
        throw error;
    }
    let closing: Promise<void> | undefined;
    return {
        close() {
            if (closing === undefined) {
                closing = (async () => {
                    stopTracking();
                    try { await server?.close(); }
                    finally { await runtime.close(); }
                })();
            }
            return closing;
        },
    };
}

export type WorkerIdentity = Pick<HostIdentity, "pid" | "started_at">;
import { randomUUID } from "node:crypto";
import { readSessionHeader } from "../../store/session-store.ts";
