import { spawn, type ChildProcess } from "node:child_process";

export interface JsonRpcError {
    readonly code: number;
    readonly message: string;
}

export class McpRpcError extends Error {
    readonly code: number;

    constructor(error: JsonRpcError) {
        super(error.message);
        this.name = "McpRpcError";
        this.code = error.code;
    }
}

export const METHOD_NOT_FOUND = -32601;

/**
 * One JSON-RPC connection to an MCP server. Both transports resolve requests
 * by id; `close` rejects everything still pending so a caller is never left
 * awaiting a dead server.
 */
export interface McpTransport {
    request(
        method: string,
        params: unknown,
        signal?: AbortSignal,
    ): Promise<unknown>;
    notify(method: string, params?: unknown): Promise<void>;
    close(): void;
    readonly alive: boolean;
}

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

export function startStdioTransport(
    command: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd: string | undefined,
): McpTransport {
    const child: ChildProcess = spawn(command[0]!, command.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    let alive = true;
    let buffer = "";

    const fail = (reason: string) => {
        if (!alive) return;
        alive = false;
        for (const request of pending.values()) {
            request.reject(new Error(reason));
        }
        pending.clear();
        child.kill();
    };

    child.on("error", (error) => fail(`mcp server failed to start: ${error.message}`));
    child.on("exit", () => fail("mcp server exited"));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) {
                dispatch(line, pending);
            }
            newline = buffer.indexOf("\n");
        }
    });

    const send = (message: Record<string, unknown>): Promise<void> =>
        new Promise((resolve, reject) => {
            if (!alive) {
                reject(new Error("mcp server is not running"));
                return;
            }
            child.stdin!.write(`${JSON.stringify(message)}\n`, (error) =>
                error ? reject(error) : resolve());
        });

    return {
        get alive() {
            return alive;
        },
        request(method, params, signal) {
            const id = nextId++;
            return new Promise<unknown>((resolve, reject) => {
                if (signal?.aborted) {
                    reject(abortError());
                    return;
                }
                const onAbort = () => {
                    pending.delete(id);
                    void send({
                        jsonrpc: "2.0",
                        method: "notifications/cancelled",
                        params: { requestId: id },
                    }).catch(() => {});
                    reject(abortError());
                };
                signal?.addEventListener("abort", onAbort, { once: true });
                pending.set(id, {
                    resolve: (value) => {
                        signal?.removeEventListener("abort", onAbort);
                        resolve(value);
                    },
                    reject: (error) => {
                        signal?.removeEventListener("abort", onAbort);
                        reject(error);
                    },
                });
                void send({ jsonrpc: "2.0", id, method, params }).catch(
                    (error) => {
                        pending.delete(id);
                        signal?.removeEventListener("abort", onAbort);
                        reject(error);
                    },
                );
            });
        },
        notify(method, params) {
            return send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
        },
        close() {
            fail("mcp connection closed");
        },
    };
}

function dispatch(line: string, pending: Map<number, PendingRequest>): void {
    let message: unknown;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    if (typeof message !== "object" || message === null) {
        return;
    }
    const { id, result, error } = message as {
        id?: unknown;
        result?: unknown;
        error?: unknown;
    };
    // Server-initiated requests and notifications are unsupported in v1 and
    // are dropped rather than answered, which the protocol tolerates for
    // notifications; no configured server has needed the request form yet.
    if (typeof id !== "number") {
        return;
    }
    const request = pending.get(id);
    if (request === undefined) {
        return;
    }
    pending.delete(id);
    if (isJsonRpcError(error)) {
        request.reject(new McpRpcError(error));
    } else {
        request.resolve(result);
    }
}

/**
 * Streamable HTTP transport: every request is one POST that answers either
 * with plain JSON or with an SSE stream, and the session id handed out on
 * the first response is echoed on every later request.
 */
export function startHttpTransport(
    url: string,
    headers: Readonly<Record<string, string>>,
): McpTransport {
    let nextId = 1;
    let alive = true;
    let sessionId: string | undefined;

    const post = async (
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<unknown> => {
        if (!alive) {
            throw new Error("mcp connection closed");
        }
        const response = await fetch(url, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(sessionId === undefined
                    ? {}
                    : { "mcp-session-id": sessionId }),
            },
            body: JSON.stringify(body),
            signal: signal ?? null,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (response.status === 202) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`mcp server answered HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
            return await readSseResponse(response, body.id as number);
        }
        const message = await response.json() as {
            result?: unknown;
            error?: unknown;
        };
        if (isJsonRpcError(message.error)) {
            throw new McpRpcError(message.error);
        }
        return message.result;
    };

    return {
        get alive() {
            return alive;
        },
        request(method, params, signal) {
            return post({ jsonrpc: "2.0", id: nextId++, method, params }, signal);
        },
        async notify(method, params) {
            await post({
                jsonrpc: "2.0",
                method,
                ...(params === undefined ? {} : { params }),
            });
        },
        close() {
            alive = false;
        },
    };
}

async function readSseResponse(
    response: Response,
    id: number,
): Promise<unknown> {
    const text = await response.text();
    // An SSE body carries `data:` lines; the response to our request is the
    // event whose JSON-RPC id matches. Other events on the stream (progress,
    // server logs) are dropped in v1.
    for (const block of text.split("\n\n")) {
        const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
        if (data.length === 0) {
            continue;
        }
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
            message = JSON.parse(data);
        } catch {
            continue;
        }
        if (message.id !== id) {
            continue;
        }
        if (isJsonRpcError(message.error)) {
            throw new McpRpcError(message.error);
        }
        return message.result;
    }
    throw new Error("mcp server SSE response did not answer the request");
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
    return typeof value === "object"
        && value !== null
        && typeof (value as JsonRpcError).code === "number"
        && typeof (value as JsonRpcError).message === "string";
}

function abortError(): Error {
    const error = new Error("mcp request aborted");
    error.name = "AbortError";
    return error;
}
