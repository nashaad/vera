import { createInterface } from "node:readline";

import type {
    ModelAdapter,
    ModelReasoningEffort,
} from "../../src/model/types.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import {
    parseClientCommand as parseEngineClientCommand,
    type AgentUpdate,
    type ClientCommand,
} from "../../src/engine/protocol.ts";
import type { MessageChannel } from "../../src/engine/message-channel.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { ModelFallbackPolicy } from "../../src/engine/recovery.ts";
import type { ToolReviewerSettings } from "../../src/engine/reviewer.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";

interface NdjsonOutput {
    write(text: string): unknown;
}

export interface RunNdjsonBridgeOptions {
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly eventLogPath?: string;
    readonly approvalMode?: ApprovalMode;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly reviewer?: ToolReviewerSettings;
}

export class NdjsonInputEndedError extends Error {
    constructor() {
        super("NDJSON input ended");
        this.name = "NdjsonInputEndedError";
    }
}

export function createNdjsonEngineEndpoint(
    input: NodeJS.ReadableStream,
    output: NdjsonOutput,
): MessageChannel<AgentUpdate, ClientCommand> {
    const incoming = new AsyncQueue<ClientCommand>();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

    void (async () => {
        try {
            for await (const line of lines) {
                if (line.trim().length === 0) {
                    continue;
                }
                incoming.push(parseClientCommand(line));
            }
            incoming.fail(new NdjsonInputEndedError());
        } catch (error) {
            incoming.fail(error);
        }
    })();

    return {
        send(update): void {
            output.write(`${JSON.stringify(update)}\n`);
        },
        receive(signal?: AbortSignal): Promise<ClientCommand> {
            return incoming.receive(signal);
        },
    };
}

export async function runNdjsonBridge(
    input: NodeJS.ReadableStream,
    output: NdjsonOutput,
    adapter: ModelAdapter,
    model: string,
    reasoningEffort?: ModelReasoningEffort,
    options: RunNdjsonBridgeOptions = {},
): Promise<void> {
    const endpoint = createNdjsonEngineEndpoint(input, output);

    try {
        await runHeadlessLoop(endpoint, adapter, model, reasoningEffort, {
            sessionPath: options.sessionPath,
            resumeSessionPath: options.resumeSessionPath,
            eventLogPath: options.eventLogPath,
            approvalMode: options.approvalMode,
            modelFallback: options.modelFallback,
            reviewer: options.reviewer,
        });
    } catch (error) {
        if (!(error instanceof NdjsonInputEndedError)) {
            throw error;
        }
    }
}

function parseClientCommand(line: string): ClientCommand {
    const value: unknown = JSON.parse(line);
    const command = parseEngineClientCommand(value);
    if (command !== undefined) {
        return command;
    }

    throw new Error("Unknown NDJSON client command");
}
