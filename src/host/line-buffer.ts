// Byte queue for newline-delimited frames. Scanned bytes are never rescanned,
// and a line is joined once, so one long frame costs O(n) instead of O(n^2).
const NEWLINE_BYTE = 0x0a;

export interface LineBufferOptions {
    readonly maxLineBytes?: number;
}

export type LineBufferResult =
    | { readonly kind: "line"; readonly bytes: Buffer }
    | { readonly kind: "oversized"; readonly byteLength: number }
    | { readonly kind: "need-more" };

const NEED_MORE: LineBufferResult = { kind: "need-more" };

export class LineBuffer {
    private readonly maxLineBytes: number;
    private chunks: Buffer[] = [];
    private totalBytes = 0;
    private scanIndex = 0;
    private scanOffset = 0;
    private scannedBytes = 0;
    private discardingBytes = 0;
    private completedOversizedBytes: number | undefined;

    constructor(options: LineBufferOptions = {}) {
        this.maxLineBytes = options.maxLineBytes ?? Number.POSITIVE_INFINITY;
    }

    push(chunk: Buffer): void {
        if (chunk.length === 0) {
            return;
        }
        if (this.discardingBytes > 0) {
            // An oversized line is dropped byte by byte until its newline.
            const newlineAt = chunk.indexOf(NEWLINE_BYTE);
            if (newlineAt === -1) {
                this.discardingBytes += chunk.length;
                return;
            }
            this.completedOversizedBytes = this.discardingBytes + newlineAt;
            this.discardingBytes = 0;
            const remaining = chunk.subarray(newlineAt + 1);
            if (remaining.length > 0) {
                this.chunks.push(remaining);
                this.totalBytes += remaining.length;
            }
            return;
        }
        this.chunks.push(chunk);
        this.totalBytes += chunk.length;
    }

    next(): LineBufferResult {
        if (this.completedOversizedBytes !== undefined) {
            const byteLength = this.completedOversizedBytes;
            this.completedOversizedBytes = undefined;
            return { kind: "oversized", byteLength };
        }
        if (this.discardingBytes > 0) {
            return NEED_MORE;
        }
        const newlineAt = this.findNewline();
        if (newlineAt === undefined) {
            if (this.totalBytes > this.maxLineBytes) {
                this.discardingBytes = this.totalBytes;
                this.reset();
            }
            return NEED_MORE;
        }
        const lineLength = this.scannedBytes
            + (newlineAt - this.scanOffset);
        if (lineLength > this.maxLineBytes) {
            this.dropLine(lineLength);
            this.resetScan();
            return { kind: "oversized", byteLength: lineLength };
        }
        const bytes = this.takeLine(lineLength);
        this.resetScan();
        return { kind: "line", bytes };
    }

    get bufferedBytes(): number {
        return this.totalBytes;
    }

    private findNewline(): number | undefined {
        while (this.scanIndex < this.chunks.length) {
            const chunk = this.chunks[this.scanIndex]!;
            const offset = chunk.indexOf(NEWLINE_BYTE, this.scanOffset);
            if (offset !== -1) {
                return offset;
            }
            this.scannedBytes += chunk.length - this.scanOffset;
            this.scanIndex += 1;
            this.scanOffset = 0;
        }
        return undefined;
    }

    private takeLine(lineLength: number): Buffer {
        const pieces: Buffer[] = [];
        let remaining = lineLength + 1;
        let index = 0;
        while (index < this.chunks.length && remaining > 0) {
            const chunk = this.chunks[index]!;
            if (chunk.length < remaining) {
                pieces.push(chunk);
                remaining -= chunk.length;
                index += 1;
                continue;
            }
            if (remaining > 1) {
                pieces.push(chunk.subarray(0, remaining - 1));
            }
            this.replaceConsumed(index, chunk.subarray(remaining));
            remaining = 0;
        }
        this.totalBytes -= lineLength + 1;
        return pieces.length === 1
            ? pieces[0]!
            : Buffer.concat(pieces, lineLength);
    }

    private dropLine(lineLength: number): void {
        let remaining = lineLength + 1;
        let index = 0;
        while (index < this.chunks.length && remaining > 0) {
            const chunk = this.chunks[index]!;
            if (chunk.length < remaining) {
                remaining -= chunk.length;
                index += 1;
                continue;
            }
            this.replaceConsumed(index, chunk.subarray(remaining));
            remaining = 0;
        }
        this.totalBytes -= lineLength + 1;
    }

    private replaceConsumed(index: number, rest: Buffer): void {
        if (rest.length > 0) {
            this.chunks.splice(0, index + 1, rest);
        } else {
            this.chunks.splice(0, index + 1);
        }
    }

    private resetScan(): void {
        this.scanIndex = 0;
        this.scanOffset = 0;
        this.scannedBytes = 0;
    }

    private reset(): void {
        this.chunks = [];
        this.totalBytes = 0;
        this.resetScan();
    }
}
