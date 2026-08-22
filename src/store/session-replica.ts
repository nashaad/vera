import {
    createSessionProjectionState,
    ingestSessionRecord,
    parseHeaderRecord,
    SessionStore,
    type SessionHeader,
    type SessionProjectionState,
} from "./session-store.ts";

/**
 * A read-only view of a session held by a process that does not own the file.
 *
 * The owner of the file stays its single writer and pushes each record it
 * appends, in file order, as the JSON object it wrote. The replica folds them
 * through the same `ingestSessionRecord` a parse uses, so a replica seeded with
 * a header and fed every following record answers every read exactly as a store
 * opened on that file at the same point.
 *
 * Line numbers are the file's own: the header is line 1 and the first record is
 * line 2. They are load-bearing rather than cosmetic. They order the stream, so
 * a gap or a swap is caught rather than absorbed, and they put the same line in
 * a rejection message here as in a parse of the file.
 */
export class SessionReplica extends SessionStore {
    private lastLineNumber = 1;
    private divergence: Error | undefined;

    private constructor(
        path: string,
        header: SessionHeader,
        state: SessionProjectionState,
    ) {
        super(path, header, state, {});
    }

    /**
     * Starts a replica at the header, with no records applied.
     *
     * The header is not a record: a parse takes it from line 1 before the fold
     * begins, so it cannot arrive through `apply` and has to be supplied here.
     * It is validated by the same check a parse runs, from the same JSON object
     * that is on line 1 of the file.
     */
    static seed(
        path: string,
        header: Record<string, unknown>,
    ): SessionReplica {
        return new SessionReplica(
            path,
            parseHeaderRecord(path, header),
            createSessionProjectionState(),
        );
    }

    /** The file line number of the last record applied; 1 before any is. */
    appliedThrough(): number {
        return this.lastLineNumber;
    }

    /**
     * Folds one record in, at its line number in the file.
     *
     * Anything a parse would reject is rejected here with the same message, and
     * a record that is not the next one is rejected as well. Both are terminal:
     * a replica that has rejected a record no longer matches the file, and it
     * refuses every later record rather than repairing itself into a state the
     * file was never in. The caller is expected to treat that as fatal, since a
     * replica whose stream broke has no way back into step.
     */
    apply(lineNumber: number, record: Record<string, unknown>): void {
        if (this.divergence !== undefined) {
            throw this.divergence;
        }
        const expected = this.lastLineNumber + 1;
        if (lineNumber !== expected) {
            throw this.diverge(
                new Error(
                    `Session replica ${this.path} expected record on line `
                        + `${expected} but received line ${lineNumber}`,
                ),
            );
        }
        try {
            ingestSessionRecord(this.path, lineNumber, record, this.projection);
        } catch (error) {
            throw this.diverge(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
        this.lastLineNumber = lineNumber;
    }

    protected override async appendRecord(): Promise<void> {
        throw new Error(
            `Session replica ${this.path} cannot write to the session file`,
        );
    }

    protected override requireActive(): void {
        throw new Error(
            `Session replica ${this.path} cannot write to the session file`,
        );
    }

    private diverge(error: Error): Error {
        this.divergence = error;
        return error;
    }
}
