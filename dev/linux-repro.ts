// Temporary CI diagnostic for the Linux-only failure of
// "@core streamed open indexes UTF-8, long lines, ..." in test/store/session-store.test.ts.
// Compares ways of appending a ~3 MiB line to a file opened with "a".
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIB = 1024 * 1024;

function report(label: string, path: string, expected: number): void {
    const bytes = readFileSync(path);
    let firstZero = -1;
    let zeroRun = 0;
    for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 0) {
            if (firstZero === -1) firstZero = i;
            if (firstZero !== -1 && zeroRun === i - firstZero) zeroRun += 1;
        }
    }
    const newlines: number[] = [];
    for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 10) newlines.push(i);
    console.log(`[${label}] size=${bytes.length} expected=${expected} ok=${bytes.length === expected}`
        + ` firstZero=${firstZero} zeroRun=${zeroRun} newlines=${JSON.stringify(newlines)}`
        + ` head=${JSON.stringify(bytes.subarray(0, 40).toString("latin1"))}`
        + ` atMiB=${Array.from(bytes.subarray(MIB - 2, MIB + 4)).map((b) => b.toString(16)).join(" ")}`);
}

function makeLine(size: number, withEmoji: boolean): string {
    const head = '{"type":"message","text":"';
    const body = withEmoji
        ? "a".repeat(MIB - 1 - head.length) + "🦜" + "b".repeat(size - MIB - 3 - head.length)
        : "a".repeat(size - head.length - 3);
    return `${head}${body}"}\n`;
}

async function viaHandleWriteFile(path: string, line: string): Promise<void> {
    const file = await open(path, "a", 0o600);
    try {
        await file.writeFile(line, "utf8");
        await file.sync();
    } finally { await file.close(); }
}

async function viaHandleWrite(path: string, line: string): Promise<void> {
    const file = await open(path, "a", 0o600);
    try {
        const buffer = Buffer.from(line, "utf8");
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
            if (bytesWritten === 0) throw new Error("zero-length write");
            offset += bytesWritten;
        }
        await file.sync();
    } finally { await file.close(); }
}

async function viaHandleWriteString(path: string, line: string): Promise<void> {
    const file = await open(path, "a", 0o600);
    try {
        await file.write(line, undefined, "utf8");
        await file.sync();
    } finally { await file.close(); }
}

async function viaAppendFile(path: string, line: string): Promise<void> {
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
}

const variants: Array<[string, (path: string, line: string) => Promise<void>]> = [
    ["handle.writeFile(string)", viaHandleWriteFile],
    ["handle.write(buffer loop)", viaHandleWrite],
    ["handle.write(string)", viaHandleWriteString],
    ["fs.appendFile(string)", viaAppendFile],
];

console.log(`platform=${process.platform} arch=${process.arch} bun=${Bun.version}`);
const dir = mkdtempSync(join(tmpdir(), "linux-repro-"));
const header = '{"type":"header"}\n';
for (const size of [64 * 1024, MIB - 10, MIB + 10, 3 * MIB + 200]) {
    for (const emoji of [false, true]) {
        if (emoji && size < MIB) continue;
        const line = makeLine(size, emoji);
        const lineBytes = Buffer.byteLength(line);
        for (const [name, write] of variants) {
            const path = join(dir, `${name.replace(/[^a-z]+/gi, "_")}-${size}-${emoji}.jsonl`);
            appendFileSync(path, header);
            const label = `${name} size=${size} emoji=${emoji}`;
            try {
                await write(path, line);
                await write(path, '{"type":"tail"}\n');
            } catch (error) { console.log(`[${label}] threw: ${String(error)}`); continue; }
            report(label, path, header.length + lineBytes + '{"type":"tail"}\n'.length);
        }
    }
}
