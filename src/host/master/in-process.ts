import { dirname, join } from "node:path";

import { defaultHostSocketPath } from "../lockfile.ts";
import type { HostIdentity, HostRequest } from "../protocol.ts";
import { startWorkerServer, type HostListener, type StartHostServerOptions } from "../server.ts";
import { startSessionHost, type SessionHost, type StartSessionHostOptions } from "../session-host.ts";
import { sessionEndpoint } from "../session-host/endpoint.ts";
import { withSessionReservation } from "../session-host/storage.ts";
import type { StopWaitTarget } from "../stop-when-idle.ts";
import { HostRouter } from "./router.ts";
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
    waitingOn(): readonly StopWaitTarget[];
    hasSession(id: string): boolean;
    cutSession(id: string, reason: string): Promise<boolean>;
    clearProviderSelection(provider: string): Promise<void>;
    notifyModelCatalogChanged(): void;
    close(): Promise<void>;
}

export async function prepareInProcessWorker(options: InProcessWorkerOptions): Promise<InProcessWorker> {
    const restoringSessions = options.sessionOptions.restoringSessions ?? new Map();
    const worker = await startSessionHost({ ...options.sessionOptions, restoringSessions });
    worker.startStorage();
    const masterEndpoint = sessionEndpoint(options.master);
    const workerEndpoint = sessionEndpoint(worker);
    const router = new HostRouter({
        master: masterEndpoint,
        worker: workerEndpoint,
        masterSocket: options.masterSocket,
        workerSocket: options.workerSocket,
        buildId: options.buildId,
    });
    let workerReady = false;
    const stopMasterTracking = options.master.handlers.onRosterChanged(() => {
        void masterEndpoint.residents().then((sessions) => router.observe("host", sessions));
    });
    const stopWorkerTracking = worker.handlers.onRosterChanged(() => {
        void workerEndpoint.residents().then((sessions) => router.observe("w0", sessions));
    });
    const onRosterChanged = (listener: () => void): (() => void) => {
        const stopMaster = options.master.handlers.onRosterChanged(listener);
        const stopWorker = worker.handlers.onRosterChanged(listener);
        return () => { stopMaster(); stopWorker(); };
    };
    const route = (from: SessionOwner) => (request: HostRequest): Promise<string | undefined> => {
        const target = sessionTarget(request);
        return target === undefined ? Promise.resolve(undefined) : router.socketFor(from, target);
    };
    const reserveAgent = async <T>(id: string, run: (reserved: boolean) => Promise<T>): Promise<T> => {
        const resident = worker.registry.agents.get(id) ?? options.master.registry.agents.get(id);
        const path = resident?.store.path ?? await options.master.handlers.storedSessionPath(id);
        if (path === undefined) return await run(false);
        try {
            return await withSessionReservation(path, restoringSessions, async () => await run(true));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return await run(false);
            throw error;
        }
    };
    const common = {
        locateAgent: (id: string) => reserveAgent(id, (reserved) => router.locate(id, reserved)),
        createAgent: async (request: Parameters<HostRouter["create"]>[0]) => {
            if (workerReady) return await router.create(request);
            const session = await masterEndpoint.create(request);
            router.observe("host", [session]);
            return session;
        },
        resumeAgent: (path: string) => withSessionReservation(path, restoringSessions, async (canonical) =>
            workerReady
                ? await router.resume(canonical, true)
                : await masterEndpoint.resume(canonical, true).then((session) => {
                    router.observe("host", [session]);
                    return session;
                })
        ),
        listAgents: () => router.list(),
        onRosterChanged,
        renameSession: (id: string, name: string | null) => reserveAgent(id, (reserved) => router.rename(id, name, reserved)),
        trashSession: (id: string) => reserveAgent(id, (reserved) => router.trash(id, reserved)),
        closeAgent: (id: string, reason?: Parameters<HostRouter["close"]>[1]) => router.close(id, reason),
        blockSession: (request: Parameters<HostRouter["block"]>[0]) => router.block(request),
        unblockSession: (request: Parameters<HostRouter["unblock"]>[0]) => router.unblock(request),
        syncAgentContext: (id: string) => router.sync(id),
        readSessionFacts: (sessions: Parameters<HostRouter["facts"]>[0], include: Parameters<HostRouter["facts"]>[1]) =>
            router.facts(sessions, include),
        searchSessions: (query: Parameters<HostRouter["search"]>[0]) => router.search(query),
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
        findAgent: async (id) => await reserveAgent(id, async (reserved) =>
            await router.find("host", id, reserved) ? options.master.registry.find(id) : undefined
        ),
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
                findAgent: async (id) => await reserveAgent(id, async (reserved) =>
                    await router.find("w0", id, reserved) ? worker.registry.find(id) : undefined
                ),
                branchAgent: branch("w0", worker),
                routeRequest: route("w0"),
                canShutdown: () => false,
                canReplace: () => false,
            }, { id: "w0", index: 0, count: 1 });
            workerReady = true;
        },
        stopMaintenance: () => worker.stopMaintenance(),
        waitingOn: () => worker.registry.stopWaitTargets(),
        hasSession: (id) => worker.registry.agents.has(id)
            || worker.registry.startingIds.has(id)
            || worker.registry.trashingIds.has(id),
        cutSession: (id, reason) => worker.registry.cutSessionForStop(id, reason),
        clearProviderSelection: (provider) => worker.clearProviderSelection(provider),
        notifyModelCatalogChanged: () => worker.registry.notifyModelCatalogChanged(),
        async close() {
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
