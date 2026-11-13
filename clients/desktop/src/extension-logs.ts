import { appendFile, mkdir, open, rename, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogChunk {
    text: string;
    nextOffset: number;
    size: number;
}

const FLUSH_MS = 250;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024;

interface Queue {
    lines: string[];
    bytes: number;
}

export function extensionLogsDir(home: string): string {
    return join(home, "machine", "desktop", "logs");
}

// Lines are queued per extension and written in one append per file per flush. Reads always go to disk.
export class ExtensionLogs {
    private readonly queues = new Map<string, Queue>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private chain: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(private readonly dir: string) {}

    append(extensionId: string, level: LogLevel, text: string): void {
        assertExtensionId(extensionId);
        if (this.closed) return;
        let queue = this.queues.get(extensionId);
        if (!queue) {
            queue = { lines: [], bytes: 0 };
            this.queues.set(extensionId, queue);
        }
        const line = formatLine(level, text);
        queue.lines.push(line);
        queue.bytes += Buffer.byteLength(line);
        // A flood between flushes keeps only what one file could hold.
        while (queue.bytes > MAX_FILE_BYTES && queue.lines.length > 1) {
            queue.bytes -= Buffer.byteLength(queue.lines.shift() ?? "");
        }
        this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
    }

    async read(extensionId: string, offset: number, limit: number): Promise<LogChunk> {
        assertExtensionId(extensionId);
        let handle: FileHandle;
        try {
            handle = await open(this.pathFor(extensionId), "r");
        } catch (error) {
            if (isMissing(error)) return { text: "", nextOffset: 0, size: 0 };
            throw error;
        }
        try {
            const { size } = await handle.stat();
            const start = offset < 0 || offset > size ? 0 : offset;
            const want = Math.min(Math.max(0, limit), MAX_READ_BYTES, size - start);
            const buffer = Buffer.alloc(want);
            const { bytesRead } = await handle.read(buffer, 0, want, start);
            const whole = buffer.subarray(0, bytesRead);
            const cut = start + bytesRead < size ? completeLength(whole) : bytesRead;
            const used = cut > 0 ? cut : bytesRead;
            return { text: whole.subarray(0, used).toString("utf8"), nextOffset: start + used, size };
        } finally {
            await handle.close();
        }
    }

    // Writes everything queued now. Flushes run one after another, so lines stay in order.
    flush(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.chain = this.chain.then(() => this.drain());
        return this.chain;
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.flush();
    }

    private async drain(): Promise<void> {
        const batches = [...this.queues];
        this.queues.clear();
        await Promise.all(batches.map(([id, queue]) => this.writeBatch(id, queue.lines)));
    }

    // A failed write drops its batch. The error stays here so the caller never sees it.
    private async writeBatch(extensionId: string, lines: string[]): Promise<void> {
        const path = this.pathFor(extensionId);
        try {
            await mkdir(this.dir, { recursive: true, mode: 0o700 });
            let size = await fileSize(path);
            let text = lines.join("");
            if (size > 0 && size + Buffer.byteLength(text) > MAX_FILE_BYTES) {
                await rename(path, `${path}.1`);
                size = 0;
            }
            if (size + Buffer.byteLength(text) > MAX_FILE_BYTES) text = newestLines(lines);
            await appendFile(path, text, { mode: 0o600 });
        } catch {
            // Dropped on purpose: a log line must never fail the caller.
        }
    }

    private pathFor(extensionId: string): string {
        return join(this.dir, `${extensionId}.log`);
    }
}

function assertExtensionId(id: string): void {
    if (id === "" || id.startsWith(".") || /[/\\\u0000]|\.\./.test(id)) {
        throw new RangeError(`Refused extension id: ${JSON.stringify(id)}`);
    }
}

function formatLine(level: LogLevel, text: string): string {
    const body = Buffer.from(`${new Date().toISOString()} ${level} ${text.replace(/[\r\n]/g, " ")}`);
    const head = body.subarray(0, MAX_LINE_BYTES);
    return `${head.subarray(0, completeLength(head)).toString("utf8")}\n`;
}

// Length without a trailing partial UTF-8 character. Only cut when the buffer does not end the file.
function completeLength(buffer: Buffer): number {
    for (let back = 1; back <= Math.min(4, buffer.length); back++) {
        const byte = buffer[buffer.length - back] ?? 0;
        if ((byte & 0xc0) === 0x80) continue;
        const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return need > back ? buffer.length - back : buffer.length;
    }
    return buffer.length;
}

// A batch larger than an empty file keeps its newest lines.
function newestLines(lines: string[]): string {
    let total = 0;
    let start = lines.length;
    while (start > 0 && total + Buffer.byteLength(lines[start - 1] ?? "") <= MAX_FILE_BYTES) {
        start -= 1;
        total += Buffer.byteLength(lines[start] ?? "");
    }
    return lines.slice(start).join("");
}

async function fileSize(path: string): Promise<number> {
    try {
        return (await stat(path)).size;
    } catch (error) {
        if (isMissing(error)) return 0;
        throw error;
    }
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
