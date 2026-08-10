import { createConnection, type Socket } from "node:net";

const DEFAULT_MAX_LINE_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_PENDING_VALUES = 1_024;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const NEWLINE_BYTE = 0x0a;

export interface HostConnectionOptions {
    readonly socketPath: string;
    readonly maxLineBytes?: number;
    readonly maxPendingValues?: number;
    readonly connectionTimeoutMs?: number;
    readonly signal?: AbortSignal;
}

/**
 * A persistent NDJSON connection over a Unix socket: send JSON values as
 * newline-delimited frames and receive parsed JSON values in order. The
 * connection attempt has a fixed deadline; an established connection remains
 * open until a peer closes it. Parsed values that arrive faster than
 * `receive()` drains them are bounded by `maxPendingValues`; past that limit
 * the socket is paused until the caller catches up.
 */
export interface HostConnection {
    send(value: unknown): Promise<void>;
    receive(): Promise<unknown>;
    closedReason(): Promise<Error>;
    close(): void;
    readonly closed: boolean;
}

export function connectHost(
    options: HostConnectionOptions,
): Promise<HostConnection> {
    options.signal?.throwIfAborted();
    const maxLineBytes = positiveInteger(
        options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
        "maximum line bytes",
    );
    const maxPendingValues = positiveInteger(
        options.maxPendingValues ?? DEFAULT_MAX_PENDING_VALUES,
        "maximum pending values",
    );
    const connectionTimeoutMs = options.connectionTimeoutMs
        ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const socket = createConnection(options.socketPath);
        const connectDeadline = setTimeout(() => {
            socket.destroy();
            options.signal?.removeEventListener("abort", onAbort);
            reject(new Error("host connection deadline exceeded"));
        }, connectionTimeoutMs);
        const onAbort = (): void => {
            clearTimeout(connectDeadline);
            socket.destroy();
            reject(options.signal?.reason ?? new DOMException(
                "Host connection aborted",
                "AbortError",
            ));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        const onConnectError = (error: Error): void => {
            clearTimeout(connectDeadline);
            options.signal?.removeEventListener("abort", onAbort);
            reject(error);
        };
        socket.once("connect", () => {
            clearTimeout(connectDeadline);
            socket.off("error", onConnectError);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(createConnection_(
                socket,
                maxLineBytes,
                maxPendingValues,
            ));
        });
        socket.once("error", onConnectError);
    });
}

function createConnection_(
    socket: Socket,
    maxLineBytes: number,
    maxPendingValues: number,
): HostConnection {
    const decoder = new TextDecoder("utf-8", { fatal: true });

    let buffered = Buffer.alloc(0);
    let closed = false;
    let remoteEnded = false;
    let failure: Error | undefined;
    const pendingValues: unknown[] = [];
    const pendingReceivers: Array<{
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }> = [];
    const pendingSends = new Set<(error: Error) => void>();
    let sendTail: Promise<void> = Promise.resolve();
    let resolveClosed: ((error: Error) => void) | undefined;
    const closedReason = new Promise<Error>((resolve) => {
        resolveClosed = resolve;
    });

    function fail(error: Error): void {
        teardown(error);
    }

    function finishRemote(): void {
        if (closed) {
            return;
        }
        if (buffered.length > 0) {
            teardown(new Error("host connection received an incomplete line"));
            return;
        }
        closed = true;
        remoteEnded = true;
        failure = new Error("host connection closed");
        resolveClosed?.(failure);
        for (const receiver of pendingReceivers.splice(0)) {
            receiver.reject(failure);
        }
        for (const rejectSend of pendingSends) {
            rejectSend(failure);
        }
        pendingSends.clear();
        socket.destroy();
    }

    function teardown(error: Error): void {
        if (closed) {
            return;
        }
        closed = true;
        failure = error;
        resolveClosed?.(error);
        pendingValues.length = 0;
        for (const receiver of pendingReceivers.splice(0)) {
            receiver.reject(error);
        }
        for (const rejectSend of pendingSends) {
            rejectSend(error);
        }
        pendingSends.clear();
        socket.destroy();
    }

    function processBufferedLines(): void {
        while (!closed) {
            if (
                pendingReceivers.length === 0
                && pendingValues.length >= maxPendingValues
            ) {
                socket.pause();
                return;
            }
            const newlineAt = buffered.indexOf(NEWLINE_BYTE);
            if (newlineAt === -1) {
                if (buffered.length > maxLineBytes) {
                    fail(new Error(
                        "host connection line exceeds maximum size",
                    ));
                }
                return;
            }
            const lineBytes = buffered.subarray(0, newlineAt);
            if (lineBytes.length > maxLineBytes) {
                fail(new Error("host connection line exceeds maximum size"));
                return;
            }
            buffered = buffered.subarray(newlineAt + 1);
            let value: unknown;
            try {
                value = JSON.parse(decoder.decode(lineBytes));
            } catch {
                fail(new Error("host connection received malformed JSON"));
                return;
            }
            const receiver = pendingReceivers.shift();
            if (receiver === undefined) {
                pendingValues.push(value);
                if (pendingValues.length >= maxPendingValues) {
                    socket.pause();
                }
            } else {
                receiver.resolve(value);
            }
        }
    }

    socket.on("data", (chunk: Buffer) => {
        if (closed) {
            return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        processBufferedLines();
    });
    socket.once("error", (error: Error) => fail(error));
    socket.once("end", finishRemote);
    socket.once("close", () => {
        if (!remoteEnded) {
            fail(new Error("host connection closed"));
        }
    });

    return {
        send(value: unknown): Promise<void> {
            if (closed) {
                return Promise.reject(
                    failure ?? new Error("host connection is closed"),
                );
            }
            let encoded: string | undefined;
            try {
                encoded = JSON.stringify(value);
            } catch (error) {
                return Promise.reject(error);
            }
            if (encoded === undefined) {
                return Promise.reject(
                    new Error("host connection cannot send this value"),
                );
            }
            const pending = sendTail.then(() => writeLine(encoded));
            sendTail = pending.catch(() => undefined);
            return pending;
        },
        receive(): Promise<unknown> {
            if (remoteEnded) {
                const value = pendingValues.shift();
                return value === undefined
                    ? Promise.reject(failure)
                    : Promise.resolve(value);
            }
            if (closed) {
                return Promise.reject(
                    failure ?? new Error("host connection is closed"),
                );
            }
            if (pendingValues.length > 0) {
                const value = pendingValues.shift();
                processBufferedLines();
                if (
                    !closed
                    && socket.isPaused()
                    && pendingValues.length < maxPendingValues
                ) {
                    socket.resume();
                }
                return Promise.resolve(value);
            }
            return new Promise((resolve, reject) => {
                pendingReceivers.push({ resolve, reject });
                processBufferedLines();
                if (!closed && socket.isPaused()) {
                    socket.resume();
                }
            });
        },
        closedReason(): Promise<Error> {
            return closedReason;
        },
        close(): void {
            teardown(new Error("host connection is closed"));
        },
        get closed(): boolean {
            return closed;
        },
    };

    function writeLine(encoded: string): Promise<void> {
        if (closed) {
            return Promise.reject(
                failure ?? new Error("host connection is closed"),
            );
        }

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let writeFinished = false;
            let drained = true;
            const onDrain = (): void => {
                drained = true;
                finish();
            };
            const cleanup = (): void => {
                pendingSends.delete(rejectSend);
                socket.off("drain", onDrain);
            };
            const rejectSend = (error: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(error);
            };
            pendingSends.add(rejectSend);
            const finish = (): void => {
                if (settled || !writeFinished || !drained) {
                    return;
                }
                settled = true;
                cleanup();
                resolve();
            };
            const flushed = socket.write(`${encoded}\n`, (error) => {
                if (error) {
                    rejectSend(error);
                    return;
                }
                writeFinished = true;
                finish();
            });
            if (!flushed) {
                drained = false;
                socket.once("drain", onDrain);
            }
        });
    }
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
