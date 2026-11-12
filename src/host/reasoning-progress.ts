/** Longest a reasoning character waits before it is reported to an attachment that hides reasoning. */
export const REASONING_PROGRESS_INTERVAL_MS = 250;

export interface ReasoningProgressOptions {
    readonly intervalMs?: number;
}

export type ReasoningProgressEmit = (
    characters: number,
    seq: number,
    counted: boolean,
) => void;

/**
 * Folds reasoning deltas into one count. A timer runs only while a count is pending, so an idle
 * attachment holds no timer; `flush` and `dispose` both clear it.
 */
export class ReasoningProgressCoalescer {
    private readonly intervalMs: number;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private characters = 0;
    private seq: number | undefined;
    private counted = false;
    private disposed = false;

    constructor(
        private readonly emit: ReasoningProgressEmit,
        options: ReasoningProgressOptions = {},
    ) {
        this.intervalMs = options.intervalMs ?? REASONING_PROGRESS_INTERVAL_MS;
    }

    /** A delta with no text still advances `seq`, so the next update stays contiguous. */
    add(characters: number, seq: number, counted: boolean): void {
        if (this.disposed) return;
        this.characters += characters;
        this.seq = seq;
        this.counted ||= counted;
        if (this.timer === undefined) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.flush();
            }, this.intervalMs);
            this.timer.unref?.();
        }
    }

    flush(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const seq = this.seq;
        if (seq === undefined || this.disposed) return;
        const characters = this.characters;
        const counted = this.counted;
        this.characters = 0;
        this.seq = undefined;
        this.counted = false;
        this.emit(characters, seq, counted);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.characters = 0;
        this.seq = undefined;
    }
}
