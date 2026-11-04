
import { LineBuffer } from "../line-buffer.ts";

export interface PipeStreams {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
}

export type PipeRequestHandler = (body: unknown) => Promise<unknown>;
export type PipeNotificationHandler = (body: unknown) => void;

export interface JsonPipe {
    request(body: unknown): Promise<unknown>;
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
    readonly reject: (error: Error) => void;
}

export function createJsonPipe(
    streams: PipeStreams,
    options: JsonPipeOptions = {},
): JsonPipe {
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let closedByUs = false;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const write = (frame: Record<string, unknown>): void => {
        if (closedByUs) {
            return;
        }
        streams.output.write(`${JSON.stringify(frame)}\n`);
    };

    const fail = (error: Error): void => {
        for (const entry of pending.values()) {
            entry.reject(error);
        }
        pending.clear();
        resolveClosed();
    };

    readLines(streams.input, (line) => {
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
        request(body: unknown): Promise<unknown> {
            const id = nextId;
            nextId += 1;
            return new Promise<unknown>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                write({ id, body });
            });
        },
        notify(body: unknown): void {
            write({ body });
        },
        closed,
        close(): void {
            closedByUs = true;
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
