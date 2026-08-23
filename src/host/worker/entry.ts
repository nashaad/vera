/**
 * The worker: one OS process that runs one turn loop and owns nothing durable.
 *
 * It holds no session file, no event log, no roster, no permission store. Its
 * whole state is the projection it folded out of records the host sent and the
 * conversation in flight. `kill -9` at any instant therefore loses exactly what
 * it is supposed to lose and nothing else.
 *
 * Speaks NDJSON on fd 0 and fd 1. fd 2 is left alone so a crash is readable.
 */

import { createInProcessChannel } from "../../engine/message-channel.ts";
import { runHeadlessLoop } from "../../engine/run-turn.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { ModelAdapter } from "../../model/types.ts";
import { createJsonPipe, type JsonPipe } from "./pipe.ts";
import { createRemoteHostBoundary } from "./remote-boundary.ts";
import type { WorkerAdapterSpec, WorkerStartNotification } from "./start.ts";

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
    // Commands can arrive before the loop exists, so they wait rather than
    // being dropped.
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

    const remote = createRemoteHostBoundary({
        pipe,
        session: options.session,
        offers: options.offers,
        capabilities: options.capabilities,
        state: options.state,
        ...(options.extensionToolDefinitions === undefined
            ? {}
            : { extensionToolDefinitions: options.extensionToolDefinitions }),
    });
    acceptHostNotification = remote.acceptNotification;
    for (const body of pendingHost.splice(0)) {
        acceptHostNotification(body);
    }

    // The client endpoint has not moved host-side yet, so it lives here and
    // its two directions ride the same pipe. See `start.ts`.
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

    let failure: string | undefined;
    try {
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
    pipe.notify({
        method: "worker.finished",
        ...(failure === undefined ? {} : { error: failure }),
    });
    // Flushed by the exit, and the host reads EOF as the process being gone
    // whether or not this line arrived.
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
    await runWorker(process.stdin, process.stdout);
    process.exit(0);
}
