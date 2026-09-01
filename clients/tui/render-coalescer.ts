
const COALESCED_UPDATES: ReadonlySet<string> = new Set([
    "assistant_delta",
    "assistant_thinking",
    "model_activity",
    "context",
    "status",
]);

export function isCoalescedUpdate(type: string): boolean {
    return COALESCED_UPDATES.has(type);
}

export interface RenderCoalescerOptions {
    readonly render: () => void;
    readonly intervalMs?: number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export interface RenderCoalescer {
    request(updateType: string): void;
    flush(): void;
    stop(): void;
}

export const STREAM_RENDER_INTERVAL_MS = 33;

export function createRenderCoalescer(
    options: RenderCoalescerOptions,
): RenderCoalescer {
    const intervalMs = options.intervalMs ?? STREAM_RENDER_INTERVAL_MS;
    const setTimer = options.setTimer
        ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer
        ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

    let timer: unknown;
    let dirty = false;

    function cancel(): void {
        if (timer !== undefined) {
            clearTimer(timer);
            timer = undefined;
        }
    }

    function flush(): void {
        cancel();
        if (!dirty) {
            return;
        }
        dirty = false;
        options.render();
    }

    return {
        request(updateType) {
            dirty = true;
            if (!isCoalescedUpdate(updateType)) {
                flush();
                return;
            }
            if (timer === undefined) {
                timer = setTimer(() => {
                    timer = undefined;
                    flush();
                }, intervalMs);
            }
        },
        flush,
        stop() {
            cancel();
            dirty = false;
        },
    };
}
