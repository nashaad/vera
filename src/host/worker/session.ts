/**
 * The worker's view of the session.
 *
 * The host is the file's single writer. The worker holds no file descriptor and
 * nothing here touches disk, so killing the worker loses nothing: every record
 * it produced was already written by the host before the loop saw the append
 * return.
 *
 * Two streams keep it in step, and they are deliberately disjoint:
 *
 * - A record the worker itself appended is already folded into its projection
 *   by the commit that produced it. The host replies with the line number it
 *   landed on, and the worker only advances its counter. Ingesting it again
 *   would double every message.
 * - A record the host wrote on its own arrives as `session.record` and is
 *   folded through `ingestSessionRecord`, the same function a parse uses.
 *
 * Both share one line-number sequence, and either can arrive first, so records
 * ahead of the sequence wait in `deferred` rather than being rejected.
 *
 * `SessionReplica` is the read-only shape of the same idea and is what a worker
 * with no writes would hold. It cannot be extended here because its constructor
 * is private, so the fold is reached through the exported `ingestSessionRecord`
 * instead; the semantics have one implementation either way.
 */

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

    /** Set once, before the loop starts. */
    setAppender(send: AppendRecordThroughHost): void {
        this.send = send;
    }

    appliedThrough(): number {
        return this.lastLineNumber;
    }

    /** A record the host wrote on its own, at its line number in the file. */
    applyHostRecord(
        lineNumber: number,
        record: Record<string, unknown>,
    ): void {
        this.deferred.set(lineNumber, record);
        this.drain();
    }

    /** A line this worker produced. Already folded in; only the counter moves. */
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
