
import { LineBuffer } from "../line-buffer.ts";

export interface PipeStreams {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
}

export type PipeRequestHandler = (body: unknown) => Promise<unknown>;
export type PipeNotificationHandler = (body: unknown) => void;

export interface JsonPipe {
    request(body: unknown, signal?: AbortSignal): Promise<unknown>;
    notify(body: unknown): void;
    readonly closed: Promise<void>;
    close(): void;
}

export interface JsonPipeOptions {
    readonly onRequest?: PipeRequestHandler;
    readonly onNotification?: PipeNotificationHandler;
}

interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
}

export function createJsonPipe(
    streams: PipeStreams,
    options: JsonPipeOptions = {},
): JsonPipe {
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let closedByUs = false;
    let outputFailed = false;
    let closeError: Error | undefined;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const write = (frame: Record<string, unknown>): void => {
        if (closedByUs || outputFailed) {
            return;
        }
        streams.output.write(`${JSON.stringify(frame)}\n`);
    };

    const fail = (error: Error): void => {
        if (closeError !== undefined) return;
        closeError = error;
        for (const entry of pending.values()) {
            entry.cleanup();
            entry.reject(error);
        }
        pending.clear();
        resolveClosed();
    };

    streams.output.on("error", (error: Error) => {
        outputFailed = true;
        fail(error);
    });
    readLines(streams.input, (line) => {
        if (closeError !== undefined) return;
        let frame: Record<string, unknown>;
        try {
            frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
            fail(new Error(`Unparseable frame on the worker pipe: ${line}`));
            return;
        }
        const id = frame.id;
        if (typeof id === "number" && ("ok" in frame || "error" in frame)) {
            const entry = pending.get(id);
            pending.delete(id);
            if (entry === undefined) {
                return;
            }
            entry.cleanup();
            if ("error" in frame) {
                entry.reject(new Error(String(frame.error)));
            } else {
                entry.resolve(frame.ok);
            }
            return;
        }
        if (typeof id === "number") {
            const handler = options.onRequest;
            if (handler === undefined) {
                write({ id, error: "This end serves no requests" });
                return;
            }
            void handler(frame.body)
                .then((result) => write({ id, ok: result ?? null }))
                .catch((error: unknown) =>
                    write({ id, error: messageOf(error) })
                );
            return;
        }
        options.onNotification?.(frame.body);
    }, () => fail(new Error("The worker pipe closed")));

    return {
        request(body: unknown, signal?: AbortSignal): Promise<unknown> {
            if (closeError !== undefined) return Promise.reject(closeError);
            if (signal?.aborted === true) return Promise.reject(signal.reason);
            const id = nextId;
            nextId += 1;
            return new Promise<unknown>((resolve, reject) => {
                const onAbort = (): void => {
                    if (!pending.delete(id)) return;
                    cleanup();
                    reject(signal?.reason);
                };
                const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
                pending.set(id, { resolve, reject, cleanup });
                signal?.addEventListener("abort", onAbort, { once: true });
                try {
                    write({ id, body });
                } catch (error) {
                    pending.delete(id);
                    cleanup();
                    reject(error);
                }
            });
        },
        notify(body: unknown): void {
            write({ body });
        },
        closed,
        close(): void {
            closedByUs = true;
            fail(new Error("The worker pipe closed"));
            streams.output.end?.();
        },
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readLines(
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void,
    onEnd: () => void,
): void {
    const decoder = new TextDecoder("utf-8");
    const lines = new LineBuffer();
    stream.on("data", (chunk: Buffer | string) => {
        lines.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        for (;;) {
            const result = lines.next();
            if (result.kind === "need-more") {
                return;
            }
            if (result.kind === "oversized") {
                continue;
            }
            const line = decoder.decode(result.bytes).trim();
            if (line !== "") {
                onLine(line);
            }
        }
    });
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("error", onEnd);
}
