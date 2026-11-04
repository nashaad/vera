export class TurnWorkClock {
    private readonly startedAt: number;
    private pauseCount = 0;
    private pausedAt: number | undefined;
    private pausedDurationMs = 0;
    private completedDurationMs: number | undefined;

    constructor(
        private readonly now: () => number = () => performance.now(),
    ) {
        this.startedAt = now();
    }

    pause(): void {
        if (this.completedDurationMs !== undefined) return;
        if (this.pauseCount === 0) this.pausedAt = this.now();
        this.pauseCount += 1;
    }

    resume(): void {
        if (this.completedDurationMs !== undefined || this.pauseCount === 0) return;
        this.pauseCount -= 1;
        if (this.pauseCount !== 0 || this.pausedAt === undefined) return;
        this.pausedDurationMs += Math.max(0, this.now() - this.pausedAt);
        this.pausedAt = undefined;
    }

    finish(): number {
        if (this.completedDurationMs !== undefined) return this.completedDurationMs;
        const finishedAt = this.pausedAt ?? this.now();
        this.completedDurationMs = Math.max(
            0,
            finishedAt - this.startedAt - this.pausedDurationMs,
        );
        return this.completedDurationMs;
    }
}
