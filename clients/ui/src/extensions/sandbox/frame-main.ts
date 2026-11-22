// Runs inside the sandboxed extension frame, which has an opaque origin and no access to the window.
// It starts the extension's worker and hands it the channel to the window. It never reads the extension's messages.

declare const __WORKER_SOURCE__: string;

interface StartMessage {
    readonly type?: unknown;
    readonly extensionId?: unknown;
}

let started = false;

window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as StartMessage | null;
    const port = event.ports[0];
    if (started || event.source !== window.parent || port === undefined) return;
    if (typeof data !== "object" || data === null || data.type !== "start" || typeof data.extensionId !== "string") return;
    started = true;
    const url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: "text/javascript" }));
    // A classic worker: a module worker started from a blob URL does not run in an opaque-origin frame.
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.postMessage({ type: "port", extensionId: data.extensionId }, [port]);
});
