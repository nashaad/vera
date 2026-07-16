import { createInterface } from "node:readline";

import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../model/types.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import { AsyncQueue } from "./async-queue.ts";
import type { AgentFrame, ClientFrame } from "./frames.ts";
import type { FrameEndpoint } from "./in-process-channel.ts";

interface FrameOutput {
    write(text: string): unknown;
}

export class NdjsonInputEndedError extends Error {
    constructor() {
        super("NDJSON input ended");
        this.name = "NdjsonInputEndedError";
    }
}

export function createNdjsonEngineEndpoint(
    input: NodeJS.ReadableStream,
    output: FrameOutput,
): FrameEndpoint<AgentFrame, ClientFrame> {
    const incoming = new AsyncQueue<ClientFrame>();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

    void (async () => {
        try {
            for await (const line of lines) {
                if (line.trim().length === 0) {
                    continue;
                }
                incoming.push(parseClientFrame(line));
            }
            incoming.fail(new NdjsonInputEndedError());
        } catch (error) {
            incoming.fail(error);
        }
    })();

    return {
        send(frame): void {
            output.write(`${JSON.stringify(frame)}\n`);
        },
        receive(signal?: AbortSignal): Promise<ClientFrame> {
            return incoming.receive(signal);
        },
    };
}

export async function runNdjsonBridge(
    input: NodeJS.ReadableStream,
    output: FrameOutput,
    adapter: ModelAdapter,
    model: string,
    reasoningEffort?: ModelReasoningEffort,
): Promise<void> {
    const endpoint = createNdjsonEngineEndpoint(input, output);

    try {
        await runHeadlessLoop(endpoint, adapter, model, reasoningEffort);
    } catch (error) {
        if (!(error instanceof NdjsonInputEndedError)) {
            throw error;
        }
    }
}

function parseClientFrame(line: string): ClientFrame {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) {
        throw new Error("NDJSON client frame must be an object");
    }

    const frame = value as Record<string, unknown>;
    if (frame.type === "prompt" && typeof frame.content === "string") {
        return { type: "prompt", content: frame.content };
    }
    if (frame.type === "abort") {
        return { type: "abort" };
    }

    throw new Error("Unknown NDJSON client frame");
}
