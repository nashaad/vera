export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_STDERR_LINE_CHARS = 64 * 1024;

export interface PushedLines {
    readonly lines: Buffer[];
    // True when a line grew past the limit; the reader stops buffering from then on.
    readonly overflow: boolean;
}

// Splits a byte stream on "\n" without ever holding more than `limit` bytes of an unfinished line.
export class LineReader {
    private parts: Buffer[] = [];
    private size = 0;
    private overflowed = false;

    constructor(private readonly limit: number = MAX_LINE_BYTES) {}

    push(chunk: Buffer): PushedLines {
        const lines: Buffer[] = [];
        if (this.overflowed) return { lines, overflow: true };
        let start = 0;
        while (start <= chunk.length) {
            const end = chunk.indexOf(0x0a, start);
            const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
            if (this.size + piece.length > this.limit) {
                this.overflowed = true;
                this.parts = [];
                this.size = 0;
                return { lines, overflow: true };
            }
            if (end === -1) {
                if (piece.length > 0) {
                    this.parts.push(piece);
                    this.size += piece.length;
                }
                break;
            }
            lines.push(this.parts.length === 0 ? piece : Buffer.concat([...this.parts, piece]));
            this.parts = [];
            this.size = 0;
            start = end + 1;
        }
        return { lines, overflow: false };
    }
}

// Decodes one stdout line as strict UTF-8 JSON. Anything else is `undefined`, which the runner refuses.
export function decodeJsonLine(line: Buffer): unknown {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
        return undefined;
    }
}
