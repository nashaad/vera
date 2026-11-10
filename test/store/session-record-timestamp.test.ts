import { expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecordTimestamp } from "../../src/store/session-record-timestamp.ts";

test("reads the last top-level timestamp without decoding a long body", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-record-timestamp-"));
    const path = join(root, "session.jsonl");
    const line = `{"timestamp":"old","message":{"content":"${"x".repeat(140_000)}","timestamp":"nested"},"time\\u0073tamp":"🦜\\ud800"}\n`;
    try {
        await writeFile(path, line);
        const file = await open(path, "r");
        try {
            expect(await readRecordTimestamp(file, 0, Buffer.byteLength(line))).toBe(JSON.parse(line).timestamp);
        } finally {
            await file.close();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reads a timestamp that crosses chunk and UTF-8 boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-record-timestamp-"));
    const path = join(root, "session.jsonl");
    const timestamp = `${"x".repeat(65_517)}🦜${"y".repeat(70_000)}`;
    const line = `${JSON.stringify({ type: "message", timestamp })}\n`;
    try {
        await writeFile(path, line);
        const file = await open(path, "r");
        try {
            expect(await readRecordTimestamp(file, 0, Buffer.byteLength(line))).toBe(timestamp);
        } finally {
            await file.close();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reads timestamps around nested strings, scalars, and repeated keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-record-timestamp-"));
    const path = join(root, "session.jsonl");
    const records = Array.from({ length: 48 }, (_, number) => {
        const value = { nested: [{ quote: '\\" and } ]', timestamp: "not the root" }, number, null, true] };
        const timestamp = `stamp-${number}-🦜-\\n`;
        return `{"timestamp":"old","prefix":${JSON.stringify(value)},"timestamp":${JSON.stringify(timestamp)},"tail":[1,false,{"x":"}"}]}\n`;
    });
    try {
        await writeFile(path, records.join(""));
        const file = await open(path, "r");
        try {
            let offset = 0;
            for (const record of records) {
                const length = Buffer.byteLength(record);
                expect(await readRecordTimestamp(file, offset, length)).toBe(JSON.parse(record).timestamp);
                offset += length;
            }
        } finally {
            await file.close();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
