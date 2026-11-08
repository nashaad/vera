
import {
    createSessionProjectionState,
    ingestSessionRecord,
    parseHeaderRecord,
    SessionStore,
} from "../../store/session-store.ts";

export type AppendRecordThroughHost = (
    record: Record<string, unknown>,
) => Promise<number>;

export class WorkerSessionStore extends SessionStore {
    private lastLineNumber = 1;
    private readonly deferred = new Map<number, Record<string, unknown>>();
    private ownAppendsInFlight = 0;
    private divergence: Error | undefined;
    private onDiverged: (error: Error) => void = () => {};
    private hostAnswersDelivery = false;
    private send: AppendRecordThroughHost = () => {
        throw new Error("The worker session store has no host to append to");
    };

    static seed(
        path: string,
        header: Record<string, unknown>,
    ): WorkerSessionStore {
        return new WorkerSessionStore(
            path,
            parseHeaderRecord(path, header),
            createSessionProjectionState(),
            {},
        );
    }

    setAppender(send: AppendRecordThroughHost): void {
        this.send = send;
    }

    /** Runs once, when the replica first falls out of step with the host. */
    watchDivergence(listener: (error: Error) => void): void {
        this.onDiverged = listener;
    }

    appliedThrough(): number {
        return this.lastLineNumber;
    }

    override hasUnansweredDeliveryTurn(): boolean {
        // The host accounts for stored-only crash cuts in its delivery answer.
        return this.hostAnswersDelivery ? false : super.hasUnansweredDeliveryTurn();
    }

    useHostDeliveryState(): void {
        this.hostAnswersDelivery = true;
    }

    applyHostRecord(
        lineNumber: number,
        record: Record<string, unknown>,
    ): void {
        this.defer(lineNumber, record);
    }

    acknowledgeOwnRecord(lineNumber: number): void {
        this.defer(lineNumber, OWN_RECORD);
    }

    protected override async appendRecord(record: object): Promise<void> {
        this.ownAppendsInFlight += 1;
        let lineNumber: number;
        try {
            lineNumber = await this.send(record as Record<string, unknown>);
        } finally {
            this.ownAppendsInFlight -= 1;
        }
        this.acknowledgeOwnRecord(lineNumber);
    }

    protected override requireActive(): void {
        this.requireInSync();
        if (this.projection.agentFailure !== undefined) {
            throw new Error("Cannot append after the terminal agent failure");
        }
    }

    private defer(lineNumber: number, record: Record<string, unknown>): void {
        this.requireInSync();
        if (lineNumber <= this.lastLineNumber || this.deferred.has(lineNumber)) {
            throw this.diverge(
                new Error(
                    `Session replica ${this.path} already applied through line `
                        + `${this.lastLineNumber} but received line ${lineNumber}`,
                ),
            );
        }
        this.deferred.set(lineNumber, record);
        this.drain();
        this.requireNoGap();
    }

    private requireInSync(): void {
        if (this.divergence !== undefined) {
            throw this.divergence;
        }
    }

    // An echo can be applied before the answer to the append it follows, so one missing line per unanswered append is not yet a gap.
    private requireNoGap(): void {
        const lines = [...this.deferred.keys()].sort((a, b) => a - b);
        const first = lines[0];
        if (first === undefined) {
            return;
        }
        const expected = this.lastLineNumber + 1;
        if (first - expected > this.ownAppendsInFlight) {
            throw this.diverge(
                new Error(
                    `Session replica ${this.path} expected line ${expected} `
                        + `but received line ${first}`,
                ),
            );
        }
        for (let index = 1; index < lines.length; index += 1) {
            const previous = lines[index - 1] as number;
            if (lines[index] !== previous + 1) {
                throw this.diverge(
                    new Error(
                        `Session replica ${this.path} expected line `
                            + `${previous + 1} but received line `
                            + `${lines[index]}`,
                    ),
                );
            }
        }
    }

    private diverge(error: Error): Error {
        this.divergence = error;
        this.onDiverged(error);
        return error;
    }

    private drain(): void {
        for (;;) {
            const next = this.lastLineNumber + 1;
            const record = this.deferred.get(next);
            if (record === undefined) {
                return;
            }
            this.deferred.delete(next);
            if (record !== OWN_RECORD) {
                try {
                    ingestSessionRecord(
                        this.path,
                        next,
                        record,
                        this.projection,
                    );
                } catch (error) {
                    throw this.diverge(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                }
            }
            this.lastLineNumber = next;
        }
    }
}

/** Marks a line the worker wrote, which must not be folded in twice. */
const OWN_RECORD: Record<string, unknown> = Object.freeze({});
