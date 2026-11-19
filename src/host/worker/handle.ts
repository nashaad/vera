
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { signalVerifiedProcessGroup } from "../../process-group.ts";
import {
    childReleaseRoot,
    RELEASE_WORKER_NAME,
    releaseBinaryPath,
} from "../../release/layout.ts";

import type { LoopState } from "../../engine/host-protocol.ts";
import type { VeraExtensionConfig } from "../../config.ts";
import type { HostBoundaryOffers } from "../../engine/host-boundary.ts";
import type { RunHeadlessLoopData } from "../../engine/loop-services.ts";
import type { RunHeadlessLoopServices } from "../../engine/loop-services.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { EngineEvent } from "../../engine/events.ts";
import type { ModelReasoningEffort, StopCause } from "../../model/types.ts";
import type { SessionStore } from "../../store/session-store.ts";
import { sessionRecordForWire } from "../../store/session-record-projection.ts";
import type { RegisteredTool } from "../../tools/types.ts";
import type { ToolRuntime } from "../../tools/runtime.ts";
import type { ManagedProcessObservationHandlers } from "../../tools/process-runtime.ts";
import { createChildObservationTracker } from "./process-observations.ts";
import { superviseWorker, type SupervisorHandle } from
    "../worker-supervisor-handle.ts";
import { NO_DEADLINE } from "../worker-supervisor.ts";
import { createJsonPipe } from "./pipe.ts";
import type { SessionBlockAck } from "./boundary-server.ts";
import {
    createWorkerBoundaryServer,
    type WorkerBoundaryServer,
} from "./boundary-server.ts";
import type {
    WorkerAdapterSpec,
    WorkerHostCapabilities,
    WorkerSessionSeed,
} from "./start.ts";
import { compactionWireSpec } from "../../engine/compaction-binding.ts";

export type WorkerOutcome =
    | { readonly kind: "finished" }
    | { readonly kind: "failed"; readonly error: string }
    | { readonly kind: "killed"; readonly signal: string }
    | { readonly kind: "exited"; readonly code: number };

export interface StartWorkerOptions {
    readonly store: SessionStore;
    readonly session: WorkerSessionSeed;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly adapter: WorkerAdapterSpec;
    readonly data?: RunHeadlessLoopData;
    readonly services?: RunHeadlessLoopServices;
    readonly offers?: HostBoundaryOffers;
    readonly state?: LoopState;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly extensions?: readonly VeraExtensionConfig[];
    readonly home?: string;
    readonly toolRuntime?: ToolRuntime;
    readonly processObservations?: ManagedProcessObservationHandlers;
    readonly deadlineMs?: number;
    readonly onUpdate?: (update: AgentUpdate, ownerId?: string) => void;
    readonly onProcessCountChanged?: (ownerId: string, count: number) => void;
    readonly command?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly blockedDirectory?: string;
}

export interface WorkerHandle {
    readonly pid: number;
    readonly reportedFailure: boolean;
    readonly hasUnsettledObservations?: boolean;
    readonly supervisor?: SupervisorHandle;
    readonly server: WorkerBoundaryServer;
    send(command: EngineCommand): void;
    injectEvent(event: EngineEvent): void;
    pushState(state: LoopState): void;
    readonly outcome: Promise<WorkerOutcome>;
    // Resolves true only when the worker reports the flag seen (or the latch released) before the timeout.
    confirmBlock(timeoutMs: number): Promise<boolean>;
    releaseBlock(timeoutMs: number): Promise<boolean>;
    // Resolves true only when the worker halted and cleared the halt before the timeout.
    cutWait(reason: string, timeoutMs: number, stopCause?: StopCause): Promise<boolean>;
    kill(): void;
}

type AckMethod = "session.latched" | "session.released" | "session.cutAck";

function ackValue(ack: SessionBlockAck): boolean {
    if (ack.method === "session.released") return true;
    if (ack.method === "session.cutAck") return ack.ok;
    return ack.latched;
}

interface AckWaiter {
    readonly expected: AckMethod;
    readonly resolve: (ok: boolean) => void;
}

// An ack settles only the request that asked for its method; any other ack leaves the request pending.
export function createAckWaiters(): {
    ask(expected: AckMethod, timeoutMs: number, send: (requestId: string) => void): Promise<boolean>;
    settle(ack: SessionBlockAck): void;
} {
    const waiters = new Map<string, AckWaiter>();
    return {
        ask(expected, timeoutMs, send) {
            return new Promise((resolve) => {
                const requestId = randomUUID();
                const timer = setTimeout(() => {
                    waiters.delete(requestId);
                    resolve(false);
                }, timeoutMs);
                waiters.set(requestId, {
                    expected,
                    resolve: (ok) => {
                        clearTimeout(timer);
                        resolve(ok);
                    },
                });
                send(requestId);
            });
        },
        settle(ack) {
            const waiter = waiters.get(ack.requestId);
            if (waiter === undefined || waiter.expected !== ack.method) return;
            waiters.delete(ack.requestId);
            waiter.resolve(ackValue(ack));
        },
    };
}

export function residentWorkerEntrypoint(): string {
    return fileURLToPath(new URL("./entry.ts", import.meta.url));
}

export function residentWorkerSpawnCommand(
    releaseRoot: string | undefined = childReleaseRoot(),
): readonly string[] {
    if (releaseRoot !== undefined) {
        const packed = releaseBinaryPath(RELEASE_WORKER_NAME, releaseRoot);
        if (existsSync(packed)) return [packed];
    }
    return [process.execPath, residentWorkerEntrypoint()];
}

// Call inside `store.exclusively`: with no append in flight the count is committed, and echoed records continue from it.
export function sessionSeedFromStore(store: SessionStore): WorkerSessionSeed {
    return { path: store.path, header: { ...store.header }, lineCount: store.appendedLineCount() };
}

export function startSeededWorker(
    options: Omit<StartWorkerOptions, "session">,
): Promise<WorkerHandle> {
    return options.store.exclusively(async () =>
        startWorker({
            ...options,
            session: sessionSeedFromStore(options.store),
        })
    );
}

/** Callers that read the seed themselves must do it inside `store.exclusively`. */
export async function startWorker(
    options: StartWorkerOptions,
): Promise<WorkerHandle> {
    const command = options.command ?? residentWorkerSpawnCommand();
    const [executable, ...args] = command;
    const startedAt = new Date().toISOString();
    const child: ChildProcess = spawn(executable as string, args, {
        argv0: "vera-worker",
        stdio: ["pipe", "pipe", "inherit"],
        detached: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined
            ? {}
            : { env: { ...process.env, ...options.env } }),
    });
    const pid = child.pid;
    if (pid === undefined || child.stdin === null || child.stdout === null) {
        throw new Error("The worker process did not start");
    }

    let reported: string | undefined | null = null;
    let resolveOutcome: (outcome: WorkerOutcome) => void = () => {};
    const outcome = new Promise<WorkerOutcome>((resolve) => {
        resolveOutcome = resolve;
    });

    const ackWaiters = createAckWaiters();
    const askBlock = (
        method: "session.confirmBlock" | "session.release",
        timeoutMs: number,
    ): Promise<boolean> => ackWaiters.ask(
        method === "session.confirmBlock" ? "session.latched" : "session.released",
        timeoutMs,
        (requestId) => pipe.notify({ method, requestId }),
    );
    const askCut = (
        reason: string,
        timeoutMs: number,
        stopCause?: StopCause,
    ): Promise<boolean> => ackWaiters.ask(
        "session.cutAck",
        timeoutMs,
        (requestId) => pipe.notify({
            method: "session.cut",
            requestId,
            reason,
            ...(stopCause === undefined ? {} : { stopCause }),
        }),
    );
    const settleBlockAck = (ack: SessionBlockAck): void => ackWaiters.settle(ack);
    const services = options.services ?? {};
    const handlers = options.processObservations;
    const canObserve = handlers?.onObservationStarted !== undefined
        && handlers.onObservationSettled !== undefined && handlers.onObservationInterrupted !== undefined;
    const tracker = !canObserve ? undefined : createChildObservationTracker(options.store.header.id, {
        onObservationStarted: handlers.onObservationStarted!,
        onObservationSettled: handlers.onObservationSettled!,
        onObservationInterrupted: handlers.onObservationInterrupted!,
    });
    const observationHandlers = tracker?.handlers;
    let supervisor: SupervisorHandle | undefined;
    const pipe = createJsonPipe(
        { input: child.stdout, output: child.stdin },
        {
            onRequest: (body) => server.handleRequest(body),
            onNotification: (body) => server.handleNotification(body),
        },
    );

    const server = createWorkerBoundaryServer({
        pipe,
        store: options.store,
        services,
        ...(options.extensionTools === undefined
            ? {}
            : { extensionTools: options.extensionTools }),
        ...(options.toolRuntime === undefined
            ? {}
            : { toolRuntime: options.toolRuntime }),
        ...(options.onUpdate === undefined
            ? {}
            : { onClientUpdate: options.onUpdate }),
        onWorkerFinished: (error?: string): void => {
            reported = error ?? undefined;
        },
        onProcessStarted: (pid, processStartedAt) => supervisor?.watchProcessGroup(pid, processStartedAt),
        onProcessSettled: (pid) => supervisor?.forgetProcessGroup(pid),
        ...(observationHandlers === undefined ? {} : { processObservations: observationHandlers }),
        onProcessCountChanged: (ownerId, count) => options.onProcessCountChanged?.(ownerId, count),
        onBlockAck: (ack) => settleBlockAck(ack),
    });

    let finishing = false;
    const finish = async (result: WorkerOutcome): Promise<void> => {
        if (finishing) return;
        finishing = true;
        const failed = await tracker?.finish() ?? 0;
        resolveOutcome(failed === 0 ? result : {
            kind: "failed",
            error: `Could not recover ${failed} child process observation(s); restart the host to retry.`,
        });
    };
    child.once("close", (code: number | null, signal: string | null) => {
        const result: WorkerOutcome = signal !== null ? { kind: "killed", signal }
            : reported === null ? { kind: "exited", code: code ?? 0 }
            : reported === undefined ? { kind: "finished" } : { kind: "failed", error: reported };
        void finish(result);
    });
    child.once("error", (error: Error) => {
        void finish({ kind: "failed", error: error.message });
    });

    supervisor = superviseWorker({
        pid,
        startedAt,
        deadlineMs: options.deadlineMs ?? NO_DEADLINE,
        processGroup: true,
    });

    pipe.notify({
        method: "worker.start",
        model: options.model,
        ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort }),
        adapter: options.adapter,
        data: options.data ?? {},
        session: options.session,
        offers: options.offers
            ?? { approvalModeRead: false, modelSettings: false, selectedAgent: false },
        capabilities: capabilitiesOf(services, options.extensionTools, canObserve),
        ...(options.extensions === undefined || options.extensions.length === 0
            ? {}
            : { extensions: options.extensions }),
        ...(options.home === undefined ? {} : { home: options.home }),
        ...(options.blockedDirectory === undefined
            ? {}
            : { blockedDirectory: options.blockedDirectory }),
        state: options.state ?? { policy: {} },
        ...(services.compaction === undefined
            ? {}
            : { compaction: compactionWireSpec(services.compaction) }),
        ...(services.toolResults === undefined
            ? {}
            : { toolResults: services.toolResults }),
        ...(options.extensionTools === undefined
            ? {}
            : {
                extensionToolDefinitions: options.extensionTools.map(
                    (tool) => ({
                        definition: tool.definition,
                        ...(tool.invocation === undefined
                            ? {}
                            : { invocation: tool.invocation }),
                        ...(tool.agents === undefined
                            ? {}
                            : { agents: tool.agents }),
                        ...(tool.commandInput === undefined
                            ? {}
                            : { commandInput: tool.commandInput }),
                    }),
                ),
            }),
    });

    options.store.watchRecords((line, record) => server.pushRecord(line, sessionRecordForWire(record)));

    return {
        pid,
        get reportedFailure() { return typeof reported === "string"; },
        get hasUnsettledObservations() { return tracker?.hasUnsettledObservations === true; },
        ...(supervisor === undefined ? {} : { supervisor }),
        server,
        send: (command_: EngineCommand) => server.sendCommand(command_),
        injectEvent: (event: EngineEvent) => server.injectEvent(event),
        pushState: (state: LoopState) => server.pushState(state),
        outcome,
        confirmBlock: (timeoutMs: number) => askBlock("session.confirmBlock", timeoutMs),
        releaseBlock: (timeoutMs: number) => askBlock("session.release", timeoutMs),
        cutWait: (reason: string, timeoutMs: number, stopCause?: StopCause) =>
            askCut(reason, timeoutMs, stopCause),
        kill(): void {
            supervisor?.killNow();
            const result = signalVerifiedProcessGroup({ pid, started_at: startedAt }, "SIGKILL");
            if (result !== "sent") {
                try {
                    child.kill("SIGKILL");
                } catch {
                }
            }
        },
    };
}

function capabilitiesOf(
    services: RunHeadlessLoopServices,
    extensionTools?: readonly RegisteredTool[],
    processObservations = false,
): WorkerHostCapabilities {
    return {
        processObservations,
        loadAgents: services.loadAgents !== undefined,
        selectAgent: services.router?.selectAgent !== undefined,
        listSkills: services.router?.listSkills !== undefined,
        invokeSkill: services.router?.invokeSkill !== undefined,
        updateApprovalMode: services.updateApprovalMode !== undefined,
        reviewToolCall: services.reviewToolCall !== undefined,
        applyHostToolEffect: services.applyToolEffect !== undefined,
        requestMissingSubagentConfiguration:
            services.requestMissingSubagentConfiguration !== undefined,
        applyCommittedToolEffect:
            services.applyCommittedToolEffect !== undefined,
        loadContextualContributions:
            services.loadContextualContributions !== undefined,
        checkSkillFile: services.checkSkillFile !== undefined,
        hooks: services.hooks !== undefined,
        reviewLog: services.reviewLog !== undefined,
        hasPendingDeliveryTurn:
            services.router?.hasPendingDeliveryTurn !== undefined
            || extensionTools !== undefined,
    };
}
