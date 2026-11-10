// Temporary CI diagnostic for the Linux-only failure of
// "@core streamed open indexes UTF-8, long lines, ..." in test/store/session-store.test.ts.
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store/session-store.ts";
import { SESSION_SCAN_CHUNK_BYTES } from "../src/store/session-lines.ts";
import { scanSessionIndex } from "../src/store/session-index-scan.ts";
import { readAsciiMessageHeader, type AsciiMessageHeader } from "../src/store/session-record-header.ts";
import { SessionFieldScanner } from "../src/store/session-json-fields.ts";

const userMessage = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });

async function attempt(shift: number, withTail: boolean): Promise<void> {
    const label = `shift=${shift} tail=${withTail}`;
    const path = join(mkdtempSync(join(tmpdir(), "linux-repro-")), "stream.jsonl");
    const store = await SessionStore.create(path, { sessionId: "stream", cwd: "/work" });
    const headerBytes = readFileSync(path).length;
    const prefix = JSON.stringify({ type: "message", id: "boundary", parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "" }] } });
    const textStart = prefix.indexOf('"text":""') + '"text":"'.length;
    const padding = SESSION_SCAN_CHUNK_BYTES - 1 - headerBytes - textStart + shift;
    const text = "a".repeat(padding) + "🦜" + "b".repeat(SESSION_SCAN_CHUNK_BYTES * 2);
    console.log(`[${label}] headerBytes=${headerBytes} textStart=${textStart} padding=${padding}`);
    try {
        await store.appendForeignRecord({ type: "message", id: "boundary", parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z", message: userMessage(text) });
    } catch (error) { console.log(`[${label}] appendForeignRecord threw: ${String(error)}`); return; }
    try {
        await store.appendMessage(userMessage("before rewind"));
    } catch (error) { console.log(`[${label}] appendMessage threw: ${String(error)}`); return; }
    if (withTail) appendFileSync(path, '{"type":"unfinished", "text":"🦜');

    const bytes = readFileSync(path);
    console.log(`[${label}] file size=${bytes.length}`);
    const lineEnds: number[] = [];
    for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 10) lineEnds.push(i);
    console.log(`[${label}] newline offsets=${JSON.stringify(lineEnds)}`);
    const line2 = bytes.subarray(lineEnds[0]! + 1, lineEnds[1]);
    console.log(`[${label}] line2 length=${line2.length} boundaryBytes=${Array.from(bytes.subarray(SESSION_SCAN_CHUNK_BYTES - 3, SESSION_SCAN_CHUNK_BYTES + 3)).map((b) => b.toString(16)).join(" ")}`);
    try { JSON.parse(line2.toString("utf8")); console.log(`[${label}] JSON.parse(line2) ok`); }
    catch (error) { console.log(`[${label}] JSON.parse(line2) failed: ${String(error)}`); }
    const header: AsciiMessageHeader = { type: "message", idStart: 0, idEnd: 0, parentStart: -1, parentEnd: -1 };
    const ascii = readAsciiMessageHeader(line2, header);
    console.log(`[${label}] readAsciiMessageHeader=${ascii} ${JSON.stringify(header)}`);
    const scanner = new SessionFieldScanner();
    const skip = scanner.read(line2, ascii);
    console.log(`[${label}] fieldScanner.read(skipIds=${ascii}) -> ${skip === undefined ? "undefined" : JSON.stringify({ type: skip.type, idCount: skip.scannedIdCount, parentCount: skip.scannedParentCount })}`);
    const full = scanner.read(line2, false);
    console.log(`[${label}] fieldScanner.read(skipIds=false) -> ${full === undefined ? "undefined" : JSON.stringify({ type: full.type, id: full.id })}`);

    // Chunk reads the way scanSessionRanges does them.
    const file = await open(path, "r");
    const chunk = Buffer.allocUnsafe(SESSION_SCAN_CHUNK_BYTES);
    let position = 0;
    const reads: number[] = [];
    while (true) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        reads.push(bytesRead);
        position += bytesRead;
    }
    await file.close();
    console.log(`[${label}] chunk bytesRead sequence=${JSON.stringify(reads)}`);

    try {
        const scanned = await scanSessionIndex(path, undefined, withTail);
        console.log(`[${label}] scanSessionIndex ok records=${scanned.index.length}`);
    } catch (error) { console.log(`[${label}] scanSessionIndex threw: ${String(error)}`); }
    try {
        const reopened = await SessionStore.open(path);
        const entry = await reopened.readIndexedMessage("boundary");
        console.log(`[${label}] SessionStore.open ok boundaryFound=${entry !== undefined}`);
    } catch (error) { console.log(`[${label}] SessionStore.open threw: ${String(error)}`); }
}

console.log(`platform=${process.platform} arch=${process.arch} bun=${Bun.version} chunk=${SESSION_SCAN_CHUNK_BYTES}`);
for (const shift of [0, -1, 1, -4, 4]) await attempt(shift, true);
await attempt(0, false);
