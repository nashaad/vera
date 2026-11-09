
import { createInProcessChannel } from "../../engine/message-channel.ts";
import { runHeadlessLoop } from "../../engine/run-turn.ts";
import type { InboundCommandRouter } from "../../engine/inbound-command-router.ts";
import { clearCutHaltWhenIdle } from "../cut-release.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { ModelAdapter } from "../../model/types.ts";
import { createJsonPipe, type JsonPipe } from "./pipe.ts";
import { veraMachineDirectoryIn } from "../../profile-paths.ts";
import { startExtensionRegistry } from "../../extensions/registry.ts";
import type {
    ExtensionRegistry,
    ExtensionRegistryFailure,
} from "../../extensions/registry.ts";
import {
    failingWorkerAdapter,
    workerAdapterWithMiddleware,
    workerModelContext,
    workerProvider,
} from "./middleware.ts";
import { createRemoteHostBoundary } from "./remote-boundary.ts";
import type { WorkerAdapterSpec, WorkerStartNotification } from "./start.ts";
import { installLiveProcess } from "../../live-process.ts";
import { createHostLogger, defaultHostLogPath } from "../host-log.ts";
import {
    createSessionBlockLatch,
    type SessionBlockLatch,
} from "../session-block-latch.ts";

export async function runWorker(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
): Promise<void> {
    let start: ((message: WorkerStartNotification) => void) | undefined;
    const started = new Promise<WorkerStartNotification>((resolve) => {
        start = resolve;
    });
    const pendingHost: unknown[] = [];
    let acceptHostNotification = (body: unknown): void => {
        pendingHost.push(body);
    };
    const pending: EngineCommand[] = [];
    let deliverCommand = (command: EngineCommand): void => {
        pending.push(command);
    };
    const pendingBlockControl: unknown[] = [];
    let blockControl = (body: unknown): void => {
        pendingBlockControl.push(body);
    };
    let blockLatch: SessionBlockLatch | undefined;

    const pipe: JsonPipe = createJsonPipe({ input, output }, {
        onNotification(body: unknown): void {
            const message = body as { readonly method?: string };
            if (message.method === "worker.start") {
                start?.(body as WorkerStartNotification);
                return;
            }
            if (
                message.method === "session.confirmBlock"
                || message.method === "session.release"
                || message.method === "session.cut"
            ) {
                blockControl(body);
                return;
            }
            if (message.method === "client.command") {
                deliverCommand(
                    (body as { readonly command: EngineCommand }).command,
                );
                return;
            }
            acceptHostNotification(body);
        },
    });

    const options = await started;
    let failure: string | undefined;
    let failureError: Error | undefined;
    let activationFailure: string | undefined;
    let inbound: InboundCommandRouter | undefined;
    const activationFailures: ExtensionRegistryFailure[] = [];
    let extensions: ExtensionRegistry | undefined;
    if (options.extensions !== undefined && options.extensions.length > 0) {
        try {
            extensions = await startExtensionRegistry({
                extensions: options.extensions,
                ...(options.home === undefined
                    ? {}
                    : {
                        storageRoots: {
                            profile: options.home,
                            machine: veraMachineDirectoryIn(options.home),
                        },
                    }),
                onFailure: (extensionFailure) => {
                    activationFailures.push(extensionFailure);
                },
            });
        } catch (error) {
            failureError = error instanceof Error ? error : new Error(String(error));
            failure = failureError.message.trim() || "Resident agent stopped unexpectedly";
        }
    }
    if (activationFailures.length > 0) {
        activationFailure = activationFailures.map(activationFailureDetail)
            .join("; ");
    }
    let replicaDiverged: (error: Error) => void = () => {};
    const replicaFailure = new Promise<never>((_resolve, reject) => {
        replicaDiverged = reject;
    });
    replicaFailure.catch(() => {});
    if (failure === undefined) {
        try {
        const adapter = activationFailure === undefined
            ? await loadAdapter(options.adapter)
            : failingWorkerAdapter(activationFailure, options.model);
        const sessionId = options.session.header.id;
        if (
            options.blockedDirectory !== undefined
            && typeof sessionId === "string"
        ) {
            blockLatch = createSessionBlockLatch({
                directory: options.blockedDirectory,
                sessionId,
                onLatched: (reason) => inbound?.halt(reason),
                onReleased: () => inbound?.clearHalt(),
            });
        }
        const latch = blockLatch;
        // The engine asks before each step; a cut holds until its turn has ended.
        let cutHold: string | undefined;
        const haltCheck = (): string | undefined => latch?.check() ?? cutHold;
        const remote = createRemoteHostBoundary({
            pipe,
            haltCheck,
            onReplicaDiverged: (error) => replicaDiverged(error),
            session: options.session,
            offers: options.offers,
            capabilities: options.capabilities,
            state: options.state,
            ...(extensions === undefined
                ? {}
                : { localExtensionTools: extensions.tools() }),
            ...(options.extensionToolDefinitions === undefined
                ? {}
                : {
                    extensionToolDefinitions:
                        options.extensionToolDefinitions,
                }),
            ...(options.compaction === undefined
                ? {}
                : { compaction: options.compaction }),
            ...(options.toolResults === undefined
                ? {}
                : { toolResults: options.toolResults }),
            onInboundReady: (ready) => {
                inbound = ready;
                const reason = latch?.check();
                if (reason !== undefined) ready.halt(reason);
            },
        });
        blockControl = (body: unknown): void => {
            const message = body as {
                readonly method: string;
                readonly requestId: string;
                readonly reason?: unknown;
            };
            if (message.method === "session.confirmBlock") {
                pipe.notify({
                    method: "session.latched",
                    requestId: message.requestId,
                    latched: latch !== undefined && latch.check() !== undefined,
                });
                return;
            }
            if (message.method === "session.cut") {
                // A held block keeps its own halt; clearing it here would release the session.
                const held = latch !== undefined && latch.check() !== undefined;
                const router = inbound;
                const ok = router !== undefined
                    && !held
                    && typeof message.reason === "string";
                if (ok) {
                    cutHold = message.reason;
                    router.halt(message.reason);
                    void clearCutHaltWhenIdle(router, () => latch?.check() !== undefined)
                        .then(() => {
                            cutHold = undefined;
                        });
                }
                pipe.notify({ method: "session.cutAck", requestId: message.requestId, ok });
                return;
            }
            latch?.release();
            pipe.notify({
                method: "session.released",
                requestId: message.requestId,
            });
        };
        for (const body of pendingBlockControl.splice(0)) {
            blockControl(body);
        }
        acceptHostNotification = remote.acceptNotification;
        for (const body of pendingHost.splice(0)) {
            acceptHostNotification(body);
        }

        const channel = createInProcessChannel();
        const client = channel.client as unknown as {
            send(message: EngineCommand): void;
        };
        deliverCommand = (command: EngineCommand): void => {
            client.send(command);
        };
        for (const command of pending.splice(0)) {
            deliverCommand(command);
        }
        forwardUpdates(channel.client as unknown as {
            receive(): Promise<AgentUpdate>;
        }, pipe);

        await Promise.race([
            runHeadlessLoop(
                channel.engine as never,
                activationFailure === undefined
                    ? workerAdapterWithMiddleware(
                        adapter,
                        extensions?.modelMiddleware() ?? [],
                        {
                            session: options.session,
                            provider: workerProvider(options.adapter),
                            events: remote.boundary.owned.eventBus,
                            inbound: () => inbound,
                        },
                    )
                    : adapter,
                options.model,
                options.reasoningEffort,
                options.data,
                {},
                remote.boundary,
            ),
            replicaFailure,
        ]);
        } catch (error) {
            failureError = error instanceof Error ? error : new Error(String(error));
            failure = failureError.message.trim() || "Resident agent stopped unexpectedly";
        }
    }
    blockLatch?.close();
    await extensions?.close();
    if (failure !== undefined && failureError !== undefined) {
        createHostLogger({ path: defaultHostLogPath(options.home) })({
            type: "resident_agent_failed",
            level: "error",
            session_id: options.session.header.id,
            message: failure,
            stack: failureError.stack ?? new Error(failure).stack,
        });
    }
    pipe.notify({
        method: "worker.finished",
        ...(failure === undefined ? {} : { error: failure }),
    });
}

function forwardUpdates(
    client: { receive(): Promise<AgentUpdate> },
    pipe: JsonPipe,
): void {
    void (async () => {
        for (;;) {
            const update = await client.receive();
            pipe.notify({ method: "client.update", update });
        }
    })();
}

function activationFailureDetail(failure: ExtensionRegistryFailure): string {
    return `Extension ${failure.extensionId ?? failure.path} failed to activate: `
        + failure.message;
}

async function loadAdapter(spec: WorkerAdapterSpec): Promise<ModelAdapter> {
    const module = await import(spec.module) as Record<string, unknown>;
    const name = spec.export ?? "default";
    const factory = module[name];
    if (typeof factory !== "function") {
        throw new Error(
            `${spec.module} has no adapter factory named ${name}`,
        );
    }
    return await (factory as (options: unknown) => Promise<ModelAdapter>)(
        spec.options,
    );
}

if (import.meta.main) {
    installLiveProcess("worker");
    await runWorker(process.stdin, process.stdout);
    await new Promise<void>((resolve) => {
        process.stdout.write("", () => resolve());
    });
    process.exit(0);
}
