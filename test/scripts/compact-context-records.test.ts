import { afterAll, expect, test } from "bun:test";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
    appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    compactContextRecords,
    compareContextSessions,
    parseCompactOptions,
} from "../../scripts/compact-context-records.ts";
import type {
    ContextMeasurement,
    ContextProjectionComponent,
} from "../../src/engine/context-measurement.ts";
import type { HostLockfile } from "../../src/host/lockfile.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const MEASUREMENT_PREFIX = '{"type":"context_measurement"';
const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("--home is required and a dry run is the default", () => {
    expect(parseCompactOptions(["--home", "/tmp/one"])).toEqual({
        home: "/tmp/one",
        write: false,
    });
    expect(parseCompactOptions(["--home", "/tmp/one", "--write"])).toEqual({
        home: "/tmp/one",
        write: true,
    });
    expect(() => parseCompactOptions([])).toThrow("Use --home");
    expect(() => parseCompactOptions(["--home"])).toThrow("--home needs a path");
    expect(() => parseCompactOptions(["--home", "/tmp/one", "--dry-run"]))
        .toThrow("Unknown argument");
});

test("a dry run reports the new sizes and leaves every byte alone", async () => {
    const home = temporaryHome();
    const session = await fullSession(home, "dry-run", 4);
    const before = readFileSync(session.path);
    const lines: string[] = [];
    const summary = await compactContextRecords(
        { home, write: false },
        (line) => lines.push(line),
    );
    expect(summary.files).toBe(1);
    expect(summary.changedFiles).toBe(1);
    expect(summary.failedFiles).toBe(0);
    expect(summary.afterBytes).toBeLessThan(summary.beforeBytes);
    expect(readFileSync(session.path).equals(before)).toBe(true);
    expect(lines.some((line) => line.includes("would rewrite"))).toBe(true);
    expect(lines.some((line) => line.includes(session.path))).toBe(true);
    expect(existsSync(join(home, "runtime", "session-backups"))).toBe(false);
});

test("writing converts only measurement lines and keeps a backup", async () => {
    const home = temporaryHome();
    const session = await fullSession(home, "write", 12);
    const before = readFileSync(session.path);
    const beforeLines = before.toString("utf8").trimEnd().split("\n");
    const lines: string[] = [];
    const summary = await compactContextRecords(
        { home, write: true },
        (line) => lines.push(line),
        { now: () => new Date("2026-11-04T12:34:56.000Z") },
    );
    expect(summary.changedFiles).toBe(1);
    expect(summary.failedFiles).toBe(0);
    expect(summary.backupDirectory).toBeDefined();
    expect(lines.some((line) => line.includes(summary.backupDirectory!)))
        .toBe(true);
    const backupDirectory = summary.backupDirectory!;
    const backupNames = readdirSync(backupDirectory);
    expect(backupNames).toEqual(["write.jsonl"]);
    expect(readFileSync(join(backupDirectory, "write.jsonl")).equals(before))
        .toBe(true);

    const after = readFileSync(session.path);
    expect(after.length).toBe(summary.afterBytes);
    const afterLines = after.toString("utf8").trimEnd().split("\n");
    expect(afterLines.length).toBe(beforeLines.length);
    let measurements = 0;
    for (let index = 0; index < afterLines.length; index += 1) {
        const line = afterLines[index]!;
        if (!line.startsWith(MEASUREMENT_PREFIX)) {
            expect(line).toBe(beforeLines[index]!);
            continue;
        }
        measurements += 1;
        const record = JSON.parse(line) as {
            measurement: ContextMeasurement;
            contextRecipe: unknown;
        };
        expect(record.contextRecipe).toBeDefined();
        expect(record.measurement.projection?.components.length).toBe(3);
    }
    expect(measurements).toBe(24);

    const originalCopy = join(home, "original-copy.jsonl");
    const convertedCopy = join(home, "converted-copy.jsonl");
    copyFileSync(join(backupDirectory, "write.jsonl"), originalCopy);
    copyFileSync(session.path, convertedCopy);
    expect(await compareContextSessions(originalCopy, convertedCopy)).toBe(13);

    const secondRun: string[] = [];
    const second = await compactContextRecords(
        { home, write: true },
        (line) => secondRun.push(line),
        { now: () => new Date("2026-11-04T12:35:56.000Z") },
    );
    expect(second.changedFiles).toBe(0);
    expect(second.backupDirectory).toBeUndefined();
    expect(readFileSync(session.path).equals(after)).toBe(true);
    expect(readdirSync(join(home, "runtime", "session-backups"))).toEqual([
        `compact-20261104T123456Z-${process.pid}`,
    ]);
});

test("a failed comparison leaves the original untouched and reports it", async () => {
    const home = temporaryHome();
    const session = await fullSession(home, "mismatch", 3);
    const before = readFileSync(session.path);
    const lines: string[] = [];
    const summary = await compactContextRecords(
        { home, write: true },
        (line) => lines.push(line),
        {
            compare: async () => {
                throw new Error("measurement differs");
            },
            now: () => new Date("2026-11-04T13:00:00.000Z"),
        },
    );
    expect(summary.changedFiles).toBe(1);
    expect(summary.failedFiles).toBe(1);
    expect(readFileSync(session.path).equals(before)).toBe(true);
    expect(lines.some((line) =>
        line.includes(session.path) && line.includes("original left untouched")
    )).toBe(true);
    expect(lines.some((line) => line.includes("measurement differs"))).toBe(true);
});

test("a torn final record is copied through untouched", async () => {
    const home = temporaryHome();
    const session = await fullSession(home, "torn", 3);
    const tail = '{"type":"context_measurement","timestamp":"torn';
    appendFileSync(session.path, tail);
    const lines: string[] = [];
    const summary = await compactContextRecords(
        { home, write: true },
        (line) => lines.push(line),
        { now: () => new Date("2026-11-04T14:00:00.000Z") },
    );
    expect(summary.changedFiles).toBe(1);
    expect(summary.failedFiles).toBe(0);
    expect(readFileSync(session.path, "utf8").endsWith(tail)).toBe(true);
});

test("a running host on the home refuses the whole run", async () => {
    const home = temporaryHome();
    const session = await fullSession(home, "host", 2);
    const before = readFileSync(session.path);
    const record = {
        schema_version: 3 as const,
        pid: 1,
        started_at: new Date().toISOString(),
        socket_path: join(home, "runtime", "host.sock"),
        build_id: "test",
    };
    const lockfile: HostLockfile = {
        publish: async () => record,
        read: async () => record,
        diagnose: async () => ({ record }),
    };
    await expect(compactContextRecords(
        { home, write: false },
        () => {},
        { lockfile },
    )).rejects.toThrow("A Vera host is running");
    expect(readFileSync(session.path).equals(before)).toBe(true);
});

interface Session {
    readonly path: string;
}

async function fullSession(
    home: string,
    name: string,
    turns: number,
): Promise<Session> {
    const directory = join(home, "runtime", "sessions");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${name}.jsonl`);
    let nextId = 0;
    const store = await SessionStore.create(path, {
        sessionId: name,
        cwd: home,
        createId: () => `message-${++nextId}`,
    });
    const captured: {
        readonly timestamp: string;
        readonly afterMessageId: string | null;
        readonly measurement: ContextMeasurement;
    }[] = [];
    for (let index = 0; index < turns; index += 1) {
        await store.appendMessage(user(`question ${index}`));
        const atUser = measurement(index * 2);
        const userEntry = await store.appendContextMeasurement(atUser);
        captured.push({
            timestamp: userEntry.timestamp,
            afterMessageId: userEntry.afterMessageId,
            measurement: atUser,
        });
        await store.appendMessage(assistant(`answer ${index}`));
        const atAnswer = measurement(index * 2 + 1);
        const answerEntry = await store.appendContextMeasurement(atAnswer);
        captured.push({
            timestamp: answerEntry.timestamp,
            afterMessageId: answerEntry.afterMessageId,
            measurement: atAnswer,
        });
    }
    const compactLines = readFileSync(path, "utf8").trimEnd().split("\n");
    let capturedIndex = 0;
    const fullLines = compactLines.map((line) => {
        if (!line.startsWith(MEASUREMENT_PREFIX)) return line;
        const compact = JSON.parse(line) as { afterMessageId: string | null };
        const entry = captured[capturedIndex]!;
        capturedIndex += 1;
        return JSON.stringify({
            type: "context_measurement",
            timestamp: entry.timestamp,
            afterMessageId: compact.afterMessageId,
            measurement: entry.measurement,
        });
    });
    const source = `${fullLines.join("\n")}\n`;
    writeFileSync(path, source);
    expect(statSync(path).size).toBe(Buffer.byteLength(source));
    return { path };
}

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function measurement(index: number): ContextMeasurement {
    const messageCount = 1 + (index % 8);
    const components: ContextProjectionComponent[] = [{
        kind: "prompt_contribution" as const,
        id: "core.user-rules",
        owner: "core",
        source: "memory",
        displayName: "User rules",
        count: 1,
        estimatedTokens: 40,
        parts: [{
            id: "rules/global.md",
            displayName: "global.md",
            scope: "user" as const,
            bytes: 160,
            estimatedTokens: 40,
        }],
    }, {
        kind: "tool_schema" as const,
        id: "tool:read",
        owner: "engine",
        source: "tool",
        displayName: "read",
        count: 1,
        estimatedTokens: 20,
    }];
    for (let position = 0; position < messageCount; position += 1) {
        components.push({
            kind: "message",
            id: `message:${position + 1}`,
            owner: "session",
            source: position % 2 === 0 ? "user" : "assistant",
            displayName: position % 2 === 0 ? "user message" : "assistant message",
            count: 1,
            estimatedTokens: 10 + position,
        });
    }
    const tokens = components.reduce(
        (total, component) => total + component.estimatedTokens,
        0,
    );
    return {
        tokens,
        capacity: 200_000,
        estimated: true,
        projection: { estimatedTokens: tokens, components },
        compaction: { triggerFraction: 0.82, triggerTokens: 164_000 },
    };
}

function temporaryHome(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-compact-records-"));
    temporaryDirectories.push(root);
    const home = join(root, ".vera");
    mkdirSync(join(home, "runtime", "sessions"), { recursive: true });
    return home;
}
