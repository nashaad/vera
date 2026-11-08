import type { McpServerConfig } from "./config.ts";
import {
    McpRpcError,
    METHOD_NOT_FOUND,
    startHttpTransport,
    startStdioTransport,
    type McpTransport,
} from "./rpc.ts";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly readOnly: boolean;
}

export interface McpPromptArgument {
    readonly name: string;
    readonly required: boolean;
}

export interface McpPromptDefinition {
    readonly name: string;
    readonly description: string;
    readonly arguments: readonly McpPromptArgument[];
}

export interface McpToolResult {
    readonly text: string;
    readonly isError: boolean;
}

interface ConnectionAttempt {
    readonly controller: AbortController;
    readonly promise: Promise<McpTransport>;
    waiters: number;
    settled: boolean;
}

export class McpServerClient {
    readonly config: McpServerConfig;
    tools: readonly McpToolDefinition[] = [];
    prompts: readonly McpPromptDefinition[] = [];
    private transport: McpTransport | undefined;
    private connecting: ConnectionAttempt | undefined;
    private closing: Promise<void> | undefined;

    constructor(config: McpServerConfig) {
        this.config = config;
    }

    get name(): string {
        return this.config.name;
    }

    async connect(signal?: AbortSignal): Promise<void> {
        await this.liveTransport(signal);
    }

    private async openTransport(signal: AbortSignal): Promise<McpTransport> {
        const transport = this.config.kind === "stdio"
            ? startStdioTransport(
                this.config.command,
                this.config.env,
                this.config.cwd,
            )
            : startHttpTransport(this.config.url, this.config.headers);
        const abort = (): void => { void transport.close(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
            await transport.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "vera-mcp", version: "0.1.0" },
            }, signal);
            await transport.notify("notifications/initialized", undefined, signal);
            this.tools = await listAllTools(transport, signal);
            this.prompts = await listAllPrompts(transport, signal);
            if (signal.aborted) throw abortError();
            return transport;
        } catch (error) {
            await transport.close();
            throw error;
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }

    async callTool(
        toolName: string,
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<McpToolResult> {
        const transport = await this.liveTransport(signal);
        const result = await transport.request("tools/call", {
            name: toolName,
            arguments: args,
        }, signal) as {
            content?: readonly unknown[];
            isError?: boolean;
        };
        return {
            text: contentText(result?.content ?? []),
            isError: result?.isError === true,
        };
    }

    async getPrompt(
        promptName: string,
        args: Readonly<Record<string, string>>,
        signal?: AbortSignal,
    ): Promise<string> {
        const transport = await this.liveTransport(signal);
        const result = await transport.request("prompts/get", {
            name: promptName,
            arguments: args,
        }, signal) as {
            messages?: readonly { content?: unknown }[];
        };
        return (result?.messages ?? [])
            .map((message) => contentText([message.content]))
            .filter((text) => text.length > 0)
            .join("\n\n");
    }

    async readResource(uri: string, signal: AbortSignal): Promise<string> {
        const transport = await this.liveTransport(signal);
        const result = await transport.request("resources/read", { uri }, signal) as {
            contents?: readonly {
                uri?: string;
                text?: unknown;
                blob?: unknown;
            }[];
        };
        return (result?.contents ?? [])
            .map((entry) =>
                typeof entry.text === "string"
                    ? entry.text
                    : `[binary resource ${entry.uri ?? uri}]`)
            .join("\n\n");
    }

    close(): Promise<void> {
        if (this.closing !== undefined) return this.closing;
        const transport = this.transport;
        this.transport = undefined;
        const attempt = this.connecting;
        attempt?.controller.abort();
        const closing = Promise.all([
            transport?.close(),
            attempt?.promise.then((connected) => connected.close(), () => {}),
        ]).then(() => {}).finally(() => {
            if (this.closing === closing) this.closing = undefined;
        });
        this.closing = closing;
        return closing;
    }

    private async liveTransport(signal?: AbortSignal): Promise<McpTransport> {
        if (signal?.aborted) throw abortError();
        if (this.closing !== undefined) {
            await waitForCleanup(this.closing, signal);
            return this.liveTransport(signal);
        }
        if (this.transport !== undefined && this.transport.alive) {
            return this.transport;
        }
        this.transport = undefined;
        let attempt = this.connecting;
        if (attempt?.controller.signal.aborted) {
            await waitForCleanup(attempt.promise, signal);
            return this.liveTransport(signal);
        }
        if (attempt === undefined) {
            const controller = new AbortController();
            const promise = this.openTransport(controller.signal).then(async (transport) => {
                if (controller.signal.aborted) {
                    await transport.close();
                    throw abortError();
                }
                this.transport = transport;
                return transport;
            }).finally(() => {
                attempt!.settled = true;
                if (this.connecting === attempt) this.connecting = undefined;
            });
            attempt = { controller, promise, waiters: 0, settled: false };
            this.connecting = attempt;
        }
        return waitForConnection(attempt, signal);
    }
}

function waitForConnection(attempt: ConnectionAttempt, signal?: AbortSignal): Promise<McpTransport> {
    attempt.waiters += 1;
    return new Promise((resolve, reject) => {
        let finished = false;
        const release = (): boolean => {
            if (finished) return false;
            finished = true;
            signal?.removeEventListener("abort", abort);
            attempt.waiters -= 1;
            if (attempt.waiters === 0 && !attempt.settled) attempt.controller.abort();
            return true;
        };
        const abort = (): void => {
            if (release()) reject(abortError());
        };
        signal?.addEventListener("abort", abort, { once: true });
        attempt.promise.then(
            (transport) => { if (release()) resolve(transport); },
            (error: unknown) => { if (release()) reject(error); },
        );
        if (signal?.aborted) abort();
    });
}

async function waitForCleanup(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => { cleanup(); reject(abortError()); };
        const cleanup = (): void => signal?.removeEventListener("abort", abort);
        signal?.addEventListener("abort", abort, { once: true });
        promise.then(
            () => { cleanup(); resolve(); },
            () => { cleanup(); resolve(); },
        );
        if (signal?.aborted) abort();
    });
}

function abortError(): Error {
    const error = new Error("mcp request aborted");
    error.name = "AbortError";
    return error;
}

async function listAllTools(
    transport: McpTransport,
    signal?: AbortSignal,
): Promise<readonly McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
        const result = await transport.request(
            "tools/list",
            cursor === undefined ? {} : { cursor },
            signal,
        ) as {
            tools?: readonly Record<string, unknown>[];
            nextCursor?: unknown;
        };
        for (const tool of result?.tools ?? []) {
            if (typeof tool.name !== "string") {
                continue;
            }
            const annotations = tool.annotations as
                | Record<string, unknown>
                | undefined;
            tools.push({
                name: tool.name,
                description: typeof tool.description === "string"
                    ? tool.description
                    : "",
                inputSchema: isObjectSchema(tool.inputSchema)
                    ? tool.inputSchema
                    : { type: "object", properties: {} },
                readOnly: annotations?.readOnlyHint === true,
            });
        }
        cursor = typeof result?.nextCursor === "string"
            ? result.nextCursor
            : undefined;
    } while (cursor !== undefined);
    return tools;
}

async function listAllPrompts(
    transport: McpTransport,
    signal?: AbortSignal,
): Promise<readonly McpPromptDefinition[]> {
    const prompts: McpPromptDefinition[] = [];
    let cursor: string | undefined;
    try {
        do {
            const result = await transport.request(
                "prompts/list",
                cursor === undefined ? {} : { cursor },
                signal,
            ) as {
                prompts?: readonly Record<string, unknown>[];
                nextCursor?: unknown;
            };
            for (const prompt of result?.prompts ?? []) {
                if (typeof prompt.name !== "string") {
                    continue;
                }
                const args = Array.isArray(prompt.arguments)
                    ? prompt.arguments
                    : [];
                prompts.push({
                    name: prompt.name,
                    description: typeof prompt.description === "string"
                        ? prompt.description
                        : "",
                    arguments: args.flatMap((argument: unknown) =>
                        typeof (argument as { name?: unknown }).name === "string"
                            ? [{
                                name: (argument as { name: string }).name,
                                required: (argument as { required?: unknown })
                                    .required === true,
                            }]
                            : []),
                });
            }
            cursor = typeof result?.nextCursor === "string"
                ? result.nextCursor
                : undefined;
        } while (cursor !== undefined);
    } catch (error) {
        if (error instanceof McpRpcError && error.code === METHOD_NOT_FOUND) {
            return [];
        }
        throw error;
    }
    return prompts;
}

export function contentText(content: readonly unknown[]): string {
    const parts: string[] = [];
    for (const item of content) {
        if (typeof item !== "object" || item === null) {
            continue;
        }
        const entry = item as Record<string, unknown>;
        if (entry.type === "text" && typeof entry.text === "string") {
            parts.push(entry.text);
        } else if (entry.type === "image" || entry.type === "audio") {
            parts.push(`[${entry.type} ${entry.mimeType ?? "unknown type"}]`);
        } else if (entry.type === "resource_link") {
            parts.push(`[resource ${entry.uri ?? "unknown"}]`);
        } else if (entry.type === "resource") {
            const resource = entry.resource as
                | Record<string, unknown>
                | undefined;
            parts.push(typeof resource?.text === "string"
                ? resource.text
                : `[resource ${resource?.uri ?? "unknown"}]`);
        }
    }
    return parts.join("\n\n");
}

function isObjectSchema(
    value: unknown,
): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
