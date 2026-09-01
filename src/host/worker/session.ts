
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

    appliedThrough(): number {
        return this.lastLineNumber;
    }

    applyHostRecord(
        lineNumber: number,
        record: Record<string, unknown>,
    ): void {
        this.deferred.set(lineNumber, record);
        this.drain();
    }

    acknowledgeOwnRecord(lineNumber: number): void {
        this.deferred.set(lineNumber, OWN_RECORD);
        this.drain();
    }

    protected override async appendRecord(record: object): Promise<void> {
        const lineNumber = await this.send(
            record as Record<string, unknown>,
        );
        this.acknowledgeOwnRecord(lineNumber);
    }

    protected override requireActive(): void {
        if (this.projection.agentFailure !== undefined) {
            throw new Error("Cannot append after the terminal agent failure");
        }
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
                ingestSessionRecord(this.path, next, record, this.projection);
            }
            this.lastLineNumber = next;
        }
    }
}

/** Marks a line the worker wrote, which must not be folded in twice. */
const OWN_RECORD: Record<string, unknown> = Object.freeze({});
