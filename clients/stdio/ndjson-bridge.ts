import { createInterface } from "node:readline";

import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../../src/model/types.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentFrame, ClientFrame } from "../../src/engine/frames.ts";
import type { FrameEndpoint } from "../../src/engine/in-process-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";

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
    if (
        frame.type === "ui_response"
        && typeof frame.requestId === "string"
        && typeof frame.response === "object"
        && frame.response !== null
    ) {
        const response = frame.response as Record<string, unknown>;
        if (
            response.type === "tool_approval"
            && (response.decision === "allow" || response.decision === "deny")
        ) {
            return {
                type: "ui_response",
                requestId: frame.requestId,
                response: {
                    type: "tool_approval",
                    decision: response.decision,
                },
            };
        }
    }

    throw new Error("Unknown NDJSON client frame");
}
