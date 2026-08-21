import { createInterface } from "node:readline";

import {
    parseClientCommand,
    type AgentUpdate,
    type ClientCommand,
} from "../../src/engine/protocol.ts";
import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { MessageChannel } from "../../src/engine/message-channel.ts";
import {
    ExtensionCommandError,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import {
    HOST_PROTOCOL_VERSION,
    parseAttachedClientMessage,
    type AttachedClientMessage,
} from "../../src/host/protocol.ts";

interface NdjsonOutput {
    write(text: string): unknown;
}

export class NdjsonInputEndedError extends Error {
    constructor() {
        super("NDJSON input ended");
        this.name = "NdjsonInputEndedError";
    }
}

/**
 * Keeps the low-level line framing useful to library callers. The resident
 * host client below owns attachment lifecycle and accepts the full attached
 * client message union.
 */
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
                const value: unknown = JSON.parse(line);
                const command = parseClientCommand(value);
                if (command === undefined) {
                    throw new Error("Unknown NDJSON client command");
                }
                incoming.push(command);
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

export interface RunAttachedStdioBridgeOptions {
    readonly signal?: AbortSignal;
}

/**
 * Bridges one attached host client to newline-delimited JSON. The bridge does
 * not interpret agent updates or UI requests, so callers can render them and
 * answer them with the same protocol the TUI uses.
 */
export async function runAttachedStdioBridge(
    input: NodeJS.ReadableStream,
    output: NdjsonOutput,
    client: AttachedAgentClient,
    options: RunAttachedStdioBridgeOptions = {},
): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    let stopping = false;
    let detachRequested = false;
    let resolveStop: (() => void) | undefined;
    let rejectStop: ((reason: unknown) => void) | undefined;
    const stopped = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
    });
    writeJson(output, {
        type: "stdio_attached",
        agent_id: client.agentId,
        workspace: client.workspace,
        protocol_version: HOST_PROTOCOL_VERSION,
    });
    writeJson(output, {
        type: "background_agents",
        ...client.backgroundAgents,
    });
    if (client.workIndex !== undefined) {
        writeJson(output, {
            type: "work_index",
            index: client.workIndex,
        });
    }
    const removeBackgroundListener = client.onBackgroundAgents((agents) => {
        writeJson(output, {
            type: "background_agents",
            ...agents,
        });
    });
    const removeWorkIndexListener = client.onWorkIndex((index) => {
        writeJson(output, {
            type: "work_index",
            index,
        });
    });

    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        lines.close();
        resolveStop?.();
    };

    const fail = (error: unknown): void => {
        if (stopping) return;
        stopping = true;
        lines.close();
        rejectStop?.(error);
    };

    const detach = async (): Promise<void> => {
        if (detachRequested) return;
        detachRequested = true;
        await client.detach();
        stop();
    };

    const onAbort = (): void => {
        void detach().catch((error) => {
            rejectStop?.(error);
            stop();
        });
    };
    if (options.signal !== undefined) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
    }

    const inputTask = consumeInput();
    const updateTask = forwardUpdates();
    try {
        await Promise.race([inputTask, updateTask, stopped]);
        if (!detachRequested && !client.closed) {
            await detach();
        }
        await Promise.allSettled([inputTask, updateTask]);
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
        removeBackgroundListener();
        removeWorkIndexListener();
        lines.close();
        if (!client.closed) {
            client.close();
        }
    }

    async function consumeInput(): Promise<void> {
        let lineNumber = 0;
        try {
            for await (const line of lines) {
                lineNumber += 1;
                if (stopping) return;
                const message = parseAttachedLine(line);
                if (message === undefined) {
                    writeJson(output, {
                        type: "stdio_rejected",
                        line: lineNumber,
                        reason: rejectionReason(line),
                    });
                    continue;
                }
                if (message.type === "detach") {
                    await detach();
                    return;
                }
                if (message.type === "list_extension_commands") {
                    await forwardExtensionList(message.request_id);
                    continue;
                }
                if (message.type === "run_extension_command") {
                    await forwardExtensionRun(message);
                    continue;
                }
                await client.send(message);
            }
            if (!stopping) {
                await detach();
            }
        } catch (error) {
            fail(error);
            throw error;
        }
    }

    async function forwardUpdates(): Promise<void> {
        try {
            while (!stopping) {
                writeJson(output, await client.receive(options.signal));
            }
        } catch (error) {
            if (detachRequested || stopping) return;
            fail(error);
            throw error;
        }
    }

    async function forwardExtensionList(requestId: string): Promise<void> {
        try {
            writeJson(output, {
                type: "extension_command_list",
                request_id: requestId,
                commands: await client.listExtensionCommands(),
            });
        } catch (error) {
            forwardExtensionFailure(requestId, error);
        }
    }

    async function forwardExtensionRun(
        message: Extract<AttachedClientMessage, { type: "run_extension_command" }>,
    ): Promise<void> {
        try {
            writeJson(output, {
                type: "extension_command_result",
                request_id: message.request_id,
                result: await client.runExtensionCommand(
                    message.command,
                    message.arguments_text,
                ),
            });
        } catch (error) {
            forwardExtensionFailure(message.request_id, error);
        }
    }

    function forwardExtensionFailure(requestId: string, error: unknown): void {
        if (!(error instanceof ExtensionCommandError)) {
            throw error;
        }
        writeJson(output, {
            type: "extension_command_failed",
            request_id: requestId,
            failure: {
                source: error.source,
                reason: error.reason,
                message: error.message,
            },
        });
    }
}

function parseAttachedLine(line: string): AttachedClientMessage | undefined {
    return parseAttachedClientMessage(line);
}

function rejectionReason(line: string): string {
    try {
        JSON.parse(line);
        return "unknown or invalid attached-client command";
    } catch {
        return "invalid JSON";
    }
}

function writeJson(output: NdjsonOutput, value: unknown): void {
    output.write(`${JSON.stringify(value)}\n`);
}
