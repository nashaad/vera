import {
    createSessionProjectionState,
    ingestSessionRecord,
    parseHeaderRecord,
    SessionStore,
    type SessionHeader,
    type SessionProjectionState,
} from "./session-store.ts";

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

    appliedThrough(): number {
        return this.lastLineNumber;
    }

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
