
import {
    createSessionProjectionState,
    ingestSessionRecord,
    parseHeaderRecord,
    SessionStore,
} from "../../store/session-store.ts";
import { closeSync, openSync, readSync } from "node:fs";
import { scanSessionRecordLocations } from "../../store/session-index-scan.ts";
import { sessionRecordForWire } from "../../store/session-record-projection.ts";
import type { SessionRecordIndex } from "../../store/session-record-index.ts";

export type AppendRecordThroughHost = (
    record: Record<string, unknown>,
) => Promise<number>;

export class WorkerSessionStore extends SessionStore {
    private lastLineNumber = 1;
    private readonly deferred = new Map<number, Record<string, unknown>>();
    private ownAppendsInFlight = 0;
    private divergence: Error | undefined;
    private readIndex: { readonly index: SessionRecordIndex; readonly limit: number } | undefined;
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

    /** Applies lines 2..lineCount from the file, one record at a time; the host fixed lineCount while no append could run. */
    applyCommittedLines(lineCount: number): void {
        if (lineCount <= 1) return;
        let read: number;
        try {
            read = visitNonEmptyLines(this.path, lineCount, (lineNumber, bytes) => {
                if (lineNumber === 1) return;
                const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
                this.applyHostRecord(lineNumber, sessionRecordForWire(record));
            });
        } catch (error) {
            if (this.divergence !== undefined) throw this.divergence;
            throw this.diverge(error instanceof Error ? error : new Error(String(error)));
        }
        if (read < lineCount) {
            throw this.diverge(new Error(
                `Session replica ${this.path} expected ${lineCount} committed lines but the file has ${read}`,
            ));
        }
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

    protected override async recordReadIndex(): Promise<{ readonly index: SessionRecordIndex; readonly limit: number }> {
        const limit = this.lastLineNumber;
        if (this.readIndex?.limit === limit) return this.readIndex;
        const index = await scanSessionRecordLocations(this.path, limit);
        if (index.length < limit) throw new Error(`Session replica ${this.path} is missing applied records`);
        this.readIndex = { index, limit };
        return this.readIndex;
    }

    protected override recordScanLimit(): number {
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

const SEED_CHUNK_BYTES = 1024 * 1024;

// Synchronous so no host notification is handled before the committed prefix is applied.
function visitNonEmptyLines(
    path: string,
    maxLines: number,
    visit: (lineNumber: number, bytes: Buffer) => void,
): number {
    const fd = openSync(path, "r");
    const chunk = Buffer.allocUnsafe(SEED_CHUNK_BYTES);
    let carry: Buffer[] = [];
    let lines = 0;
    let position = 0;
    try {
        while (lines < maxLines) {
            const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            const view = chunk.subarray(0, bytesRead);
            let start = 0;
            while (lines < maxLines) {
                const end = view.indexOf(10, start);
                if (end < 0) break;
                const piece = view.subarray(start, end);
                const bytes = carry.length === 0 ? piece : Buffer.concat([...carry, piece]);
                carry = [];
                start = end + 1;
                if (bytes.length === 0) continue;
                lines += 1;
                visit(lines, bytes);
            }
            if (start < bytesRead && lines < maxLines) carry.push(Buffer.from(view.subarray(start)));
        }
    } finally {
        closeSync(fd);
    }
    return lines;
}

/** Marks a line the worker wrote, which must not be folded in twice. */
const OWN_RECORD: Record<string, unknown> = Object.freeze({});
