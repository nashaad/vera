import { STREAM_RENDER_INTERVAL_MS } from "./frame-budget.ts";

const COALESCED_UPDATES: ReadonlySet<string> = new Set([
    "assistant_delta",
    "assistant_thinking",
    "model_activity",
    "context",
    "status",
    // Reported from inside a render, so an immediate repaint would nest.
    "transcript_changed",
    // Extension events fire after the client applies the update; its own frame
    // request paints them, so this one must not flush first.
    "agent_event",
]);

export function isCoalescedUpdate(type: string): boolean {
    return COALESCED_UPDATES.has(type);
}

export interface RenderCoalescerOptions {
    readonly render: () => void;
    readonly intervalMs?: () => number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export interface RenderCoalescer {
    request(updateType: string): void;
    flush(): void;
    stop(): void;
}

export function createRenderCoalescer(
    options: RenderCoalescerOptions,
): RenderCoalescer {
    const intervalMs = options.intervalMs ?? (() => STREAM_RENDER_INTERVAL_MS);
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
                }, intervalMs());
            }
        },
        flush,
        stop() {
            cancel();
            dirty = false;
        },
    };
}
