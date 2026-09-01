
import { createInProcessChannel } from "../../engine/message-channel.ts";
import { runHeadlessLoop } from "../../engine/run-turn.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { ModelAdapter } from "../../model/types.ts";
import { createJsonPipe, type JsonPipe } from "./pipe.ts";
import { startExtensionRegistry } from "../../extensions/registry.ts";
import { createRemoteHostBoundary } from "./remote-boundary.ts";
import type { WorkerAdapterSpec, WorkerStartNotification } from "./start.ts";
import { installLiveProcess } from "../../live-process.ts";

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

    const pipe: JsonPipe = createJsonPipe({ input, output }, {
        onNotification(body: unknown): void {
            const message = body as { readonly method?: string };
            if (message.method === "worker.start") {
                start?.(body as WorkerStartNotification);
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
    const adapter = await loadAdapter(options.adapter);

    const extensions = options.extensions === undefined
            || options.extensions.length === 0
        ? undefined
        : await startExtensionRegistry({
            extensions: options.extensions,
            onFailure: () => {},
        });
    let failure: string | undefined;
    try {
        const remote = createRemoteHostBoundary({
            pipe,
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
        });
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

        await runHeadlessLoop(
            channel.engine as never,
            adapter,
            options.model,
            options.reasoningEffort,
            options.data,
            {},
            remote.boundary,
        );
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    await extensions?.close();
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
