// Runs inside the extension's Web Worker, in a sandboxed frame with no access to the window. Every message
// leaves as an envelope the window parses again.

import { MAX_REASON_CHARS, parseToWorker, type FromWorker, type PlainData, type ToWorker } from "../envelope.ts";
import { createVera, type Handler } from "./vera-api.ts";

interface WorkerScope {
    onmessage: ((event: MessageEvent) => void) | null;
    addEventListener(type: "error" | "unhandledrejection", listener: (event: Event) => void): void;
}

interface ActivateModule {
    readonly activate?: unknown;
}

const scope = globalThis as unknown as WorkerScope;

function reasonOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, MAX_REASON_CHARS);
}

async function load(message: Extract<ToWorker, { type: "load" }>, extensionId: string, handlers: Map<string, Handler>, send: (message: FromWorker) => void): Promise<void> {
    // The extension is one self-contained module: a blob URL has nothing for a relative import to resolve against.
    const url = URL.createObjectURL(new Blob([message.source], { type: "text/javascript" }));
    try {
        const module = await import(/* @vite-ignore */ url) as ActivateModule;
        if (typeof module.activate !== "function") throw new Error("The extension does not export activate().");
        await module.activate(createVera(extensionId, new Set(message.commands), handlers, send));
        send({ type: "loaded" });
    } catch (error) {
        send({ type: "load-failed", reason: reasonOf(error) });
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function run(call: number, command: string, args: PlainData | undefined, handlers: Map<string, Handler>, send: (message: FromWorker) => void): Promise<void> {
    const handler = handlers.get(command);
    if (handler === undefined) {
        send({ type: "failed", call, reason: `Command "${command}" has no handler.` });
        return;
    }
    try {
        await handler(args);
        send({ type: "done", call });
    } catch (error) {
        send({ type: "failed", call, reason: reasonOf(error) });
    }
}

// The frame hands over one port; the worker answers on it and ignores everything else.
function serve(port: MessagePort, extensionId: string): void {
    const handlers = new Map<string, Handler>();
    const send = (message: FromWorker): void => port.postMessage(message);
    // Errors outside a command, such as a timer callback that throws, reach the log instead of vanishing.
    scope.addEventListener("error", (event) => {
        send({ type: "log", level: "error", text: reasonOf((event as ErrorEvent).error ?? (event as ErrorEvent).message) });
    });
    scope.addEventListener("unhandledrejection", (event) => {
        send({ type: "log", level: "error", text: reasonOf((event as PromiseRejectionEvent).reason) });
    });
    port.onmessage = (event) => {
        const message = parseToWorker(event.data);
        if (message === undefined) return;
        if (message.type === "ping") send({ type: "pong", n: message.n });
        else if (message.type === "load") void load(message, extensionId, handlers, send);
        else void run(message.call, message.command, message.args, handlers, send);
    };
}

scope.onmessage = (event) => {
    const data: unknown = event.data;
    const port = event.ports[0];
    if (port === undefined || typeof data !== "object" || data === null) return;
    const { type, extensionId } = data as { type?: unknown; extensionId?: unknown };
    if (type !== "port" || typeof extensionId !== "string") return;
    scope.onmessage = null;
    serve(port, extensionId);
};
