/**
 * Starts a worker and the supervisor that can kill it.
 *
 * The host is the worker's parent, which is what closes the pid-reuse window:
 * a pid cannot be reused before its parent reaps it, and the supervisor is
 * handed the pid rather than spawning the worker itself, so the worker holds no
 * channel on which to ask for an extension.
 *
 * The deadline is the caller's. Nothing here invents one, renews one, or lets
 * the worker influence one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { LoopState } from "../../engine/host-protocol.ts";
import type { VeraExtensionConfig } from "../../config.ts";
import type { HostBoundaryOffers } from "../../engine/host-boundary.ts";
import type { RunHeadlessLoopData } from "../../engine/loop-services.ts";
import type { RunHeadlessLoopServices } from "../../engine/loop-services.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { EngineEvent } from "../../engine/events.ts";
import type { ModelReasoningEffort } from "../../model/types.ts";
import type { SessionStore } from "../../store/session-store.ts";
import type { RegisteredTool } from "../../tools/types.ts";
import type { ToolRuntime } from "../../tools/runtime.ts";
import { superviseWorker, type SupervisorHandle } from
    "../worker-supervisor-handle.ts";
import { NO_DEADLINE } from "../worker-supervisor.ts";
import { createJsonPipe } from "./pipe.ts";
import {
    createWorkerBoundaryServer,
    type WorkerBoundaryServer,
} from "./boundary-server.ts";
import type {
    WorkerAdapterSpec,
    WorkerHostCapabilities,
    WorkerSessionSeed,
} from "./start.ts";

const WORKER_ENTRY = fileURLToPath(new URL("./entry.ts", import.meta.url));

/**
 * How a worker stopped, always exactly one of these.
 *
 * A worker that vanishes without a word still lands on one of them, which is
 * the difference between a kill that is observable and an agent that silently
 * disappears.
 */
export type WorkerOutcome =
    /** The loop returned. */
    | { readonly kind: "finished" }
    /** The loop threw. */
    | { readonly kind: "failed"; readonly error: string }
    /** The process died on a signal, ours or anyone's. */
    | { readonly kind: "killed"; readonly signal: string }
    /** The process exited without saying why. */
    | { readonly kind: "exited"; readonly code: number };

export interface StartWorkerOptions {
    /** The real store. This process stays its only writer. */
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
    readonly toolRuntime?: ToolRuntime;
    /**
     * Absolute wall-clock milliseconds. The supervisor SIGKILLs the worker at
     * this instant whatever the worker is doing. Defaults to NO_DEADLINE, so
     * the timer never fires while the host-gone and worker-exited switches
     * stay armed.
     */
    readonly deadlineMs?: number;
    readonly onUpdate?: (update: AgentUpdate, ownerId?: string) => void;
    readonly command?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
}

export interface WorkerHandle {
    readonly pid: number;
    readonly supervisor?: SupervisorHandle;
    readonly server: WorkerBoundaryServer;
    send(command: EngineCommand): void;
    injectEvent(event: EngineEvent): void;
    pushState(state: LoopState): void;
    /** Resolves once, with the one terminal outcome. */
    readonly outcome: Promise<WorkerOutcome>;
    /** SIGKILL, through the supervisor when there is one. */
    kill(): void;
}

export async function startWorker(
    options: StartWorkerOptions,
): Promise<WorkerHandle> {
    const command = options.command ?? ["bun", WORKER_ENTRY];
    const [executable, ...args] = command;
    const child: ChildProcess = spawn(executable as string, args, {
        stdio: ["pipe", "pipe", "inherit"],
        // The worker leads its own process group so a kill can contain tools
        // and other descendants it started, not only the JavaScript loop.
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

    const services = options.services ?? {};
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
        onProcessStarted: (pid) => supervisor?.watchProcessGroup(pid),
        onProcessSettled: (pid) => supervisor?.forgetProcessGroup(pid),
    });

    // `close` rather than `exit`: the last stdout data can still be in flight
    // when the process is already gone, and it carries `worker.finished`.
    child.once("close", (code: number | null, signal: string | null) => {
        if (signal !== null) {
            resolveOutcome({ kind: "killed", signal });
            return;
        }
        if (reported === null) {
            resolveOutcome({ kind: "exited", code: code ?? 0 });
            return;
        }
        resolveOutcome(
            reported === undefined
                ? { kind: "finished" }
                : { kind: "failed", error: reported },
        );
    });
    child.once("error", (error: Error) => {
        resolveOutcome({ kind: "failed", error: error.message });
    });

    supervisor = superviseWorker({
        pid,
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
            ?? { approvalModeRead: false, modelSettings: false, agentWear: false },
        capabilities: capabilitiesOf(services, options.extensionTools),
        ...(options.extensions === undefined || options.extensions.length === 0
            ? {}
            : { extensions: options.extensions }),
        state: options.state ?? { policy: {} },
        ...(options.extensionTools === undefined
            ? {}
            : {
                extensionToolDefinitions: options.extensionTools.map(
                    (tool) => ({
                        definition: tool.definition,
                        ...(tool.invocation === undefined
                            ? {}
                            : { invocation: tool.invocation }),
                    }),
                ),
            }),
    });

    return {
        pid,
        ...(supervisor === undefined ? {} : { supervisor }),
        server,
        send: (command_: EngineCommand) => server.sendCommand(command_),
        injectEvent: (event: EngineEvent) => server.injectEvent(event),
        pushState: (state: LoopState) => server.pushState(state),
        outcome,
        kill(): void {
            supervisor?.killNow();
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {
                    // Already gone, which is the state the caller wanted.
                }
            }
        },
    };
}

function capabilitiesOf(
    services: RunHeadlessLoopServices,
    extensionTools?: readonly RegisteredTool[],
): WorkerHostCapabilities {
    return {
        wearAgent: services.router?.wearAgent !== undefined,
        updateApprovalMode: services.updateApprovalMode !== undefined,
        reviewToolCall: services.reviewToolCall !== undefined,
        applyHostToolEffect: services.applyToolEffect !== undefined,
        applyCommittedToolEffect:
            services.applyCommittedToolEffect !== undefined,
        loadContextualContributions:
            services.loadContextualContributions !== undefined,
        hooks: services.hooks !== undefined,
        reviewLog: services.reviewLog !== undefined,
        hasPendingDeliveryTurn:
            services.router?.hasPendingDeliveryTurn !== undefined
            || extensionTools !== undefined,
    };
}
