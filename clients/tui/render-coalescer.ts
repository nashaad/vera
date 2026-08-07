/**
 * One repaint per frame for a burst of updates.
 *
 * A fast model delivers its answer as a stream of small deltas. Repainting on
 * each one rewrites a growing markdown node and the whole transcript container
 * dozens of times a second, which the terminal shows as flicker. State is
 * still applied per update: only the repaint is coalesced, so the frame that
 * lands is the newest state rather than a stale one.
 *
 * An update that changes what the user can act on repaints at once. Waiting a
 * frame to show an approval card, or leaving one on screen after it is
 * answered, is a keystroke going to the wrong surface.
 */

/**
 * The updates that only add to what is already on screen. Everything else
 * repaints immediately, so a type added later is immediate until it is listed
 * here on purpose.
 */
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
    /** The longest a coalesced repaint waits. Roughly 30 frames a second. */
    readonly intervalMs?: number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export interface RenderCoalescer {
    /** Repaints now, or within a frame, according to the update's type. */
    request(updateType: string): void;
    /** Repaints if anything is waiting to be shown. */
    flush(): void;
    /** Drops a pending repaint without running it. */
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
