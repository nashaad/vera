import type {
    Readable,
    Writable,
} from "node:stream";

import type { JsonValue } from "../sdk/hooks.ts";

const DEFAULT_MAX_LINE_BYTES = 1_024 * 1_024;
const NEWLINE_BYTE = 0x0a;

export const EXTENSION_RPC_VERSION = 1;

export type ExtensionRpcMethod =
    | "activate"
    | "invoke"
    | "dispose"
    | "capability";

export type ExtensionRpcErrorCode =
    | "invalid_frame"
    | "protocol_mismatch"
    | "unknown_handler"
    | "undeclared_capability"
    | "handler_failed"
    | "timeout"
    | "cancelled"
    | "disposed"
    | "exited";

export interface ExtensionRpcHandlerContext {
    readonly signal: AbortSignal;
}

export type ExtensionRpcHandler = (
    params: JsonValue,
    context: ExtensionRpcHandlerContext,
) => Promise<unknown>;

export interface ExtensionRpcRequestOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export interface ExtensionRpcPeerOptions {
    readonly input: Readable;
    readonly output: Writable;
    readonly label: string;
    readonly requestIdPrefix: "h" | "e";
    readonly maxLineBytes?: number;
}

export interface ExtensionRpcPeer {
    request(
        method: ExtensionRpcMethod,
        params: JsonValue,
        options: ExtensionRpcRequestOptions,
    ): Promise<JsonValue>;
    register(
        method: ExtensionRpcMethod,
        handler: ExtensionRpcHandler,
    ): () => void;
    close(error?: Error): void;
    readonly closed: boolean;
}

export interface ExtensionRpcRequest {
    readonly type: "request";
    readonly requestId: string;
    readonly method: ExtensionRpcMethod;
    readonly params: JsonValue;
}

export interface ExtensionRpcResult {
    readonly type: "result";
    readonly requestId: string;
    readonly value: JsonValue;
}

export interface ExtensionRpcError {
    readonly type: "error";
    readonly requestId: string;
    readonly code: ExtensionRpcErrorCode;
    readonly message: string;
}

export interface ExtensionRpcCancel {
    readonly type: "cancel";
    readonly requestId: string;
}

export type ExtensionRpcFrame =
    | ExtensionRpcRequest
    | ExtensionRpcResult
    | ExtensionRpcError
    | ExtensionRpcCancel;

interface PendingRequest {
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
    readonly removeAbortListener: () => void;
}

export class ExtensionRpcRemoteError extends Error {
    readonly code: ExtensionRpcErrorCode;

    constructor(code: ExtensionRpcErrorCode, message: string) {
        super(message);
        this.name = "ExtensionRpcRemoteError";
        this.code = code;
    }
}

export class ExtensionRpcHandlerError extends Error {
    readonly code: ExtensionRpcErrorCode;

    constructor(code: ExtensionRpcErrorCode, message: string) {
        super(message);
        this.name = "ExtensionRpcHandlerError";
        this.code = code;
    }
}

export function createExtensionRpcPeer(
    options: ExtensionRpcPeerOptions,
): ExtensionRpcPeer {
    const maxLineBytes = positiveInteger(
        options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
        "extension RPC maximum line bytes",
    );
    const handlers = new Map<ExtensionRpcMethod, ExtensionRpcHandler>();
    const pending = new Map<string, PendingRequest>();
    const active = new Map<string, AbortController>();
    let nextRequestId = 1;
    let closed = false;
    let failure: Error | undefined;
    let sendTail = Promise.resolve();

    options.output.on("error", (error) => fail(asError(error)));
    options.output.on("close", () => {
        fail(new Error(`${options.label} extension RPC output closed`));
    });
    options.output.on("finish", () => {
        fail(new Error(`${options.label} extension RPC output ended`));
    });
    void readMessages().catch((error) => fail(asError(error)));

    return {
        request(
            method: ExtensionRpcMethod,
            params: JsonValue,
            requestOptions: ExtensionRpcRequestOptions,
        ): Promise<JsonValue> {
            if (closed) {
                return Promise.reject(closedError());
            }
            if (method.trim().length === 0) {
                return Promise.reject(
                    new Error("extension RPC method must not be empty"),
                );
            }
            const timeoutMs = positiveInteger(
                requestOptions.timeoutMs,
                "extension RPC timeout",
            );
            if (requestOptions.signal?.aborted) {
                return Promise.reject(abortError());
            }
            if (!isJsonValue(params)) {
                return Promise.reject(
                    new Error("extension RPC params must be JSON data"),
                );
            }

            const requestId = `${options.requestIdPrefix}${nextRequestId}`;
            nextRequestId += 1;
            return new Promise<JsonValue>((resolve, reject) => {
                const cancel = (error: Error): void => {
                    const request = pending.get(requestId);
                    if (request === undefined) {
                        return;
                    }
                    pending.delete(requestId);
                    finishPending(request);
                    reject(error);
                    void send({
                        type: "cancel",
                        requestId,
                    }).catch(() => undefined);
                };
                const onAbort = (): void => cancel(abortError());
                requestOptions.signal?.addEventListener("abort", onAbort, {
                    once: true,
                });
                const timeout = setTimeout(() => {
                    cancel(new Error(
                        `${options.label} extension RPC ${method} timed out after ${timeoutMs}ms`,
                    ));
                }, timeoutMs);
                pending.set(requestId, {
                    resolve,
                    reject,
                    timeout,
                    removeAbortListener: () =>
                        requestOptions.signal?.removeEventListener(
                            "abort",
                            onAbort,
                        ),
                });
                void send({
                    type: "request",
                    requestId,
                    method,
                    params,
                }).catch((error) => {
                    cancel(asError(error));
                });
            });
        },
        register(
            method: ExtensionRpcMethod,
            handler: ExtensionRpcHandler,
        ): () => void {
            if (closed) {
                throw closedError();
            }
            if (method.trim().length === 0) {
                throw new Error("extension RPC method must not be empty");
            }
            if (handlers.has(method)) {
                throw new Error(
                    `Duplicate extension RPC method: ${method}`,
                );
            }
            handlers.set(method, handler);
            return () => {
                if (handlers.get(method) === handler) {
                    handlers.delete(method);
                }
            };
        },
        close(error?: Error): void {
            fail(error ?? new Error(`${options.label} extension RPC closed`));
        },
        get closed(): boolean {
            return closed;
        },
    };

    async function readMessages(): Promise<void> {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffered = Buffer.alloc(0);
        for await (const chunk of options.input) {
            if (closed) {
                return;
            }
            buffered = Buffer.concat([
                buffered,
                typeof chunk === "string" ? Buffer.from(chunk) : chunk,
            ]);
            while (!closed) {
                const newlineAt = buffered.indexOf(NEWLINE_BYTE);
                if (newlineAt === -1) {
                    if (buffered.length > maxLineBytes) {
                        throw new Error(
                            `${options.label} extension RPC line exceeds maximum size`,
                        );
                    }
                    break;
                }
                const line = buffered.subarray(0, newlineAt);
                buffered = buffered.subarray(newlineAt + 1);
                if (line.length > maxLineBytes) {
                    throw new Error(
                        `${options.label} extension RPC line exceeds maximum size`,
                    );
                }
                let value: unknown;
                try {
                    value = JSON.parse(decoder.decode(line));
                } catch {
                    throw new Error(
                        `${options.label} extension RPC received malformed JSON`,
                    );
                }
                const message = parseExtensionRpcFrame(value);
                if (message === undefined) {
                    throw new Error(
                        `${options.label} extension RPC received an invalid message`,
                    );
                }
                receive(message);
            }
        }
        if (buffered.length > 0) {
            throw new Error(
                `${options.label} extension RPC received an incomplete line`,
            );
        }
        throw new Error(`${options.label} extension RPC input ended`);
    }

    function receive(message: ExtensionRpcFrame): void {
        if (message.type === "request") {
            void handleRequest(message).catch((error) => fail(asError(error)));
            return;
        }
        if (message.type === "cancel") {
            active.get(message.requestId)?.abort();
            return;
        }

        const request = pending.get(message.requestId);
        if (request === undefined) {
            return;
        }
        pending.delete(message.requestId);
        finishPending(request);
        if (message.type === "result") {
            request.resolve(message.value);
        } else {
            request.reject(new ExtensionRpcRemoteError(
                message.code,
                message.message,
            ));
        }
    }

    async function handleRequest(
        request: ExtensionRpcRequest,
    ): Promise<void> {
        if (active.has(request.requestId)) {
            throw new Error(
                `${options.label} extension RPC received duplicate live request ID: ${request.requestId}`,
            );
        }

        const controller = new AbortController();
        active.set(request.requestId, controller);
        try {
            const handler = handlers.get(request.method);
            if (handler === undefined) {
                await sendFailure(
                    request.requestId,
                    "unknown_handler",
                    `Unknown extension RPC method: ${request.method}`,
                );
                return;
            }
            const result = await handler(request.params, {
                signal: controller.signal,
            });
            if (!isJsonValue(result)) {
                await sendFailure(
                    request.requestId,
                    "handler_failed",
                    `Extension RPC method ${request.method} returned non-JSON data`,
                );
                return;
            }
            if (controller.signal.aborted) {
                await sendFailure(
                    request.requestId,
                    "cancelled",
                    "Extension RPC request was cancelled",
                );
                return;
            }
            await send({
                type: "result",
                requestId: request.requestId,
                value: result,
            });
        } catch (error) {
            const handlerError = error instanceof ExtensionRpcHandlerError
                ? error
                : undefined;
            await sendFailure(
                request.requestId,
                controller.signal.aborted
                    ? "cancelled"
                    : handlerError?.code ?? "handler_failed",
                nonEmptyErrorMessage(error),
            );
        } finally {
            active.delete(request.requestId);
        }
    }

    function sendFailure(
        requestId: string,
        code: ExtensionRpcErrorCode,
        message: string,
    ): Promise<void> {
        return send({
            type: "error",
            requestId,
            code,
            message,
        });
    }

    function send(message: ExtensionRpcFrame): Promise<void> {
        if (closed) {
            return Promise.reject(closedError());
        }
        const encoded = `${JSON.stringify(message)}\n`;
        const write = sendTail
            .then(() => writeText(options.output, encoded))
            .catch((error) => {
                fail(asError(error));
                throw error;
            });
        sendTail = write.catch(() => undefined);
        return write;
    }

    function fail(error: Error): void {
        if (closed) {
            return;
        }
        closed = true;
        failure = error;
        for (const request of pending.values()) {
            finishPending(request);
            request.reject(error);
        }
        pending.clear();
        for (const controller of active.values()) {
            controller.abort();
        }
        active.clear();
        options.input.destroy();
        options.output.destroy();
    }

    function closedError(): Error {
        return failure
            ?? new Error(`${options.label} extension RPC is closed`);
    }
}

export function parseExtensionRpcFrame(
    value: unknown,
): ExtensionRpcFrame | undefined {
    if (!isPlainObject(value) || typeof value.type !== "string") {
        return undefined;
    }
    if (
        value.type === "request"
        && hasExactKeys(value, ["type", "requestId", "method", "params"])
        && isId(value.requestId)
        && isExtensionRpcMethod(value.method)
        && isJsonValue(value.params)
    ) {
        return {
            type: "request",
            requestId: value.requestId,
            method: value.method,
            params: value.params,
        };
    }
    if (
        value.type === "result"
        && hasExactKeys(value, ["type", "requestId", "value"])
        && isId(value.requestId)
        && isJsonValue(value.value)
    ) {
        return {
            type: "result",
            requestId: value.requestId,
            value: value.value,
        };
    }
    if (
        value.type === "error"
        && hasExactKeys(
            value,
            ["type", "requestId", "code", "message"],
        )
        && isId(value.requestId)
        && isExtensionRpcErrorCode(value.code)
        && typeof value.message === "string"
        && value.message.length > 0
    ) {
        return {
            type: "error",
            requestId: value.requestId,
            code: value.code,
            message: value.message,
        };
    }
    if (
        value.type === "cancel"
        && hasExactKeys(value, ["type", "requestId"])
        && isId(value.requestId)
    ) {
        return { type: "cancel", requestId: value.requestId };
    }
    return undefined;
}

function isExtensionRpcMethod(
    value: unknown,
): value is ExtensionRpcMethod {
    return value === "activate"
        || value === "invoke"
        || value === "dispose"
        || value === "capability";
}

function isExtensionRpcErrorCode(
    value: unknown,
): value is ExtensionRpcErrorCode {
    return value === "invalid_frame"
        || value === "protocol_mismatch"
        || value === "unknown_handler"
        || value === "undeclared_capability"
        || value === "handler_failed"
        || value === "timeout"
        || value === "cancelled"
        || value === "disposed"
        || value === "exited";
}

function writeText(output: Writable, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        output.write(text, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function finishPending(request: PendingRequest): void {
    clearTimeout(request.timeout);
    request.removeAbortListener();
}

function isId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length
        && keys.every((key) => Object.hasOwn(value, key));
}

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (!isPlainObject(value)) {
        return false;
    }
    return Object.values(value).every(isJsonValue);
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function abortError(): Error {
    const error = new Error("extension RPC request was cancelled");
    error.name = "AbortError";
    return error;
}

function nonEmptyErrorMessage(error: unknown): string {
    const message = asError(error).message.trim();
    return message.length === 0 ? "Extension RPC handler failed" : message;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
