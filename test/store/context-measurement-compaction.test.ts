import { afterAll, expect, test } from "bun:test";
import {
    appendFileSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareContextSessions } from "../../scripts/compact-context-records.ts";
import type {
    ContextMeasurement,
    ContextProjectionComponent,
} from "../../src/engine/context-measurement.ts";
import { buildContextReport } from "../../src/core-extensions/context/context-report.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import {
    compactContextMeasurement,
} from "../../src/store/context-measurement-record.ts";
import { SessionReplica } from "../../src/store/session-replica.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface Captured {
    readonly afterMessageId: string | null;
    readonly measurement: ContextMeasurement;
}

test("compact records give the same measurement and /context at every rewind point", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const fullPath = join(directory, "session-full.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "compact-equivalence",
        cwd: directory,
        createId: counter(),
    });
    const users: string[] = [];
    const captured: Captured[] = [];
    for (let index = 0; index < 80; index += 1) {
        const userMessage = await store.appendMessage(user(`question ${index}`));
        users.push(userMessage.id);
        const afterUser = store.activeHeadId();
        const atUser = growingMeasurement(captured.length);
        await store.appendContextMeasurement(atUser);
        captured.push({ afterMessageId: afterUser, measurement: atUser });
        await store.appendMessage(assistant(`answer ${index}`));
        const afterAnswer = store.activeHeadId();
        const atAnswer = growingMeasurement(captured.length);
        await store.appendContextMeasurement(atAnswer);
        captured.push({ afterMessageId: afterAnswer, measurement: atAnswer });
    }

    const compactSource = readFileSync(path, "utf8");
    const compactLines = compactSource.slice(0, -1).split("\n");
    const compactMeasurements = compactLines.filter((line) =>
        line.startsWith('{"type":"context_measurement"')
    );
    expect(compactMeasurements.length).toBe(captured.length);
    for (const line of compactMeasurements) {
        expect(line).toContain('"contextRecipe":');
        const record = JSON.parse(line) as {
            measurement: ContextMeasurement;
        };
        expect(record.measurement.projection?.components.length).toBeLessThanOrEqual(3);
    }

    let capturedIndex = 0;
    const fullLines = compactLines.map((line) => {
        if (!line.startsWith('{"type":"context_measurement"')) return line;
        const compact = JSON.parse(line) as {
            readonly timestamp: string;
            readonly afterMessageId: string | null;
        };
        const entry = captured[capturedIndex]!;
        capturedIndex += 1;
        return JSON.stringify({
            type: "context_measurement",
            timestamp: compact.timestamp,
            afterMessageId: compact.afterMessageId,
            measurement: entry.measurement,
        });
    });
    writeFileSync(fullPath, `${fullLines.join("\n")}\n`);

    const fullBytes = Buffer.byteLength(fullLines.join("\n"));
    const compactBytes = Buffer.byteLength(compactLines.join("\n"));
    expect(compactBytes).toBeLessThan(fullBytes);

    const compactStore = await SessionStore.open(path);
    const fullStore = await SessionStore.open(fullPath);
    expect(compactStore.latestContextMeasurement()).toEqual(
        fullStore.latestContextMeasurement(),
    );
    expect(compactStore.latestContextMeasurement()?.projection?.components.length)
        .toBeGreaterThan(1);
    expect(
        (compactStore as unknown as {
            projection: { contextMeasurementEntries: unknown[] };
        }).projection.contextMeasurementEntries.length,
    ).toBeLessThanOrEqual(users.length + 1);

    // The shared checker also runs buildContextReport at width 120 after a
    // rewind before every active user message. It appends rewind records, so
    // these disposable files are the right input.
    expect(await compareContextSessions(fullPath, path)).toBe(users.length + 1);
});

test("a keyframe every 128 records reloads after a rewind across it", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "compact-keyframes",
        cwd: directory,
        createId: counter(),
    });
    const users: string[] = [];
    const measurements: ContextMeasurement[] = [];
    for (let index = 0; index < 140; index += 1) {
        const userMessage = await store.appendMessage(user(`question ${index}`));
        users.push(userMessage.id);
        measurements.push(growingMeasurement(measurements.length));
        await store.appendContextMeasurement(measurements.at(-1)!);
        await store.appendMessage(assistant(`answer ${index}`));
        measurements.push(growingMeasurement(measurements.length));
        await store.appendContextMeasurement(measurements.at(-1)!);
    }
    const source = readFileSync(path, "utf8");
    const measurementLines = source.slice(0, -1).split("\n").filter((line) =>
        line.startsWith('{"type":"context_measurement"')
    );
    const keyframes = measurementLines.filter((line) =>
        (JSON.parse(line) as { contextRecipe: { keyframe: boolean } }).contextRecipe.keyframe
    );
    expect(keyframes.length).toBeGreaterThanOrEqual(2);

    const reopened = await SessionStore.open(path);
    expect(reopened.latestContextMeasurement()?.tokens).toBe(
        measurements.at(-1)!.tokens,
    );
    await reopened.rewindBefore(users[139]!);
    expect(reopened.latestContextMeasurement()?.tokens).toBe(
        measurements[277]!.tokens,
    );
    const reopenedAgain = await SessionStore.open(path);
    expect(reopenedAgain.latestContextMeasurement()?.tokens).toBe(
        measurements[277]!.tokens,
    );
    await reopenedAgain.rewindBefore(users[10]!);
    expect(reopenedAgain.latestContextMeasurement()?.tokens).toBe(
        measurements[19]!.tokens,
    );
});

test("a full record before compact records still loads", async () => {
    const directory = temporaryDirectory();
    const compactPath = join(directory, "session.jsonl");
    const mixedPath = join(directory, "session-mixed.jsonl");
    const store = await SessionStore.create(compactPath, {
        sessionId: "compact-mixed",
        cwd: directory,
        createId: counter(),
    });
    const captured: Captured[] = [];
    for (let index = 0; index < 6; index += 1) {
        await store.appendMessage(user(`question ${index}`));
        const atUser = growingMeasurement(captured.length);
        await store.appendContextMeasurement(atUser);
        captured.push({
            afterMessageId: store.activeHeadId(),
            measurement: atUser,
        });
        await store.appendMessage(assistant(`answer ${index}`));
        const atAnswer = growingMeasurement(captured.length);
        await store.appendContextMeasurement(atAnswer);
        captured.push({
            afterMessageId: store.activeHeadId(),
            measurement: atAnswer,
        });
    }
    const compactLines = readFileSync(compactPath, "utf8").slice(0, -1).split("\n");
    let measurementIndex = 0;
    const mixedLines = compactLines.map((line) => {
        if (!line.startsWith('{"type":"context_measurement"')) return line;
        const compact = JSON.parse(line) as {
            readonly timestamp: string;
            readonly afterMessageId: string | null;
        };
        const entry = captured[measurementIndex]!;
        measurementIndex += 1;
        if (measurementIndex <= 5) {
            return JSON.stringify({
                type: "context_measurement",
                timestamp: compact.timestamp,
                afterMessageId: compact.afterMessageId,
                measurement: entry.measurement,
            });
        }
        if (measurementIndex === 6) {
            const keyframe = compactContextMeasurement(
                entry.measurement,
                undefined,
                true,
            );
            return JSON.stringify({
                type: "context_measurement",
                timestamp: compact.timestamp,
                afterMessageId: compact.afterMessageId,
                measurement: keyframe.measurement,
                contextRecipe: keyframe.recipe,
            });
        }
        return line;
    });
    writeFileSync(mixedPath, `${mixedLines.join("\n")}\n`);

    const mixed = await SessionStore.open(mixedPath);
    const compactStore = await SessionStore.open(compactPath);
    expect(mixed.latestContextMeasurement()).toEqual(
        compactStore.latestContextMeasurement(),
    );
    expect(contextReport(mixed.latestContextMeasurement())).toEqual(
        contextReport(compactStore.latestContextMeasurement()),
    );
});

test("opening a full record file and appending writes a keyframe", async () => {
    const directory = temporaryDirectory();
    const compactPath = join(directory, "session.jsonl");
    const fullPath = join(directory, "session-full.jsonl");
    const store = await SessionStore.create(compactPath, {
        sessionId: "compact-upgrade",
        cwd: directory,
        createId: counter(),
    });
    const captured: ContextMeasurement[] = [];
    for (let index = 0; index < 3; index += 1) {
        await store.appendMessage(user(`question ${index}`));
        captured.push(growingMeasurement(captured.length));
        await store.appendContextMeasurement(captured.at(-1)!);
        await store.appendMessage(assistant(`answer ${index}`));
        captured.push(growingMeasurement(captured.length));
        await store.appendContextMeasurement(captured.at(-1)!);
    }
    const compactLines = readFileSync(compactPath, "utf8").slice(0, -1).split("\n");
    let measurementIndex = 0;
    const fullLines = compactLines.map((line) => {
        if (!line.startsWith('{"type":"context_measurement"')) return line;
        const compact = JSON.parse(line) as {
            readonly timestamp: string;
            readonly afterMessageId: string | null;
        };
        const measurement = captured[measurementIndex]!;
        measurementIndex += 1;
        return JSON.stringify({
            type: "context_measurement",
            timestamp: compact.timestamp,
            afterMessageId: compact.afterMessageId,
            measurement,
        });
    });
    writeFileSync(fullPath, `${fullLines.join("\n")}\n`);

    const fullStore = await SessionStore.open(fullPath);
    const next = growingMeasurement(40);
    await fullStore.appendContextMeasurement(next);
    const appended = JSON.parse(
        readFileSync(fullPath, "utf8").trimEnd().split("\n").at(-1)!,
    ) as { contextRecipe: { keyframe: boolean } };
    expect(appended.contextRecipe.keyframe).toBe(true);
    const reopened = await SessionStore.open(fullPath);
    expect(reopened.latestContextMeasurement()).toEqual(next);
});

test("a torn final measurement line leaves the last good answer", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "compact-torn",
        cwd: directory,
        createId: counter(),
    });
    const measurements: ContextMeasurement[] = [];
    for (let index = 0; index < 3; index += 1) {
        await store.appendMessage(user(`question ${index}`));
        measurements.push(growingMeasurement(measurements.length));
        await store.appendContextMeasurement(measurements.at(-1)!);
        await store.appendMessage(assistant(`answer ${index}`));
        measurements.push(growingMeasurement(measurements.length));
        await store.appendContextMeasurement(measurements.at(-1)!);
    }
    appendFileSync(
        path,
        '{"type":"context_measurement","timestamp":"torn","afterMessageId":',
    );
    const reopened = await SessionStore.open(path);
    expect(reopened.latestContextMeasurement()).toEqual(measurements.at(-1)!);
    expect(readFileSync(path, "utf8")).not.toContain('"timestamp":"torn"');
    const next = growingMeasurement(80);
    await reopened.appendContextMeasurement(next);
    const afterAppend = await SessionStore.open(path);
    expect(afterAppend.latestContextMeasurement()).toEqual(next);
});

test("a session replica rebuilds compact measurement records", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "compact-replica",
        cwd: directory,
        createId: counter(),
    });
    for (let index = 0; index < 4; index += 1) {
        await store.appendMessage(user(`question ${index}`));
        await store.appendContextMeasurement(growingMeasurement(index * 2));
        await store.appendMessage(assistant(`answer ${index}`));
        await store.appendContextMeasurement(growingMeasurement(index * 2 + 1));
    }
    const lines = readFileSync(path, "utf8").slice(0, -1).split("\n");
    const replica = SessionReplica.seed(
        path,
        JSON.parse(lines[0]!) as Record<string, unknown>,
    );
    for (let index = 1; index < lines.length; index += 1) {
        replica.apply(index + 1, JSON.parse(lines[index]!) as Record<string, unknown>);
    }
    const reopened = await SessionStore.open(path);
    expect(replica.latestContextMeasurement()).toEqual(
        reopened.latestContextMeasurement(),
    );
    expect(contextReport(replica.latestContextMeasurement())).toEqual(
        contextReport(reopened.latestContextMeasurement()),
    );
});

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

function growingMeasurement(index: number): ContextMeasurement {
    const messageCount = 1 + (index % 40);
    const promptTokens = 40;
    const toolTokens = 20;
    const messageTokens = Array.from(
        { length: messageCount },
        (_, position) => 10 + (position % 5),
    );
    const tokens = promptTokens + toolTokens
        + messageTokens.reduce((total, value) => total + value, 0);
    const components: ContextProjectionComponent[] = [{
        kind: "prompt_contribution",
        id: "core.user-rules",
        owner: "core",
        source: "memory",
        displayName: "User rules",
        count: 1,
        estimatedTokens: promptTokens,
        parts: [{
            id: "rules/global.md",
            displayName: "global.md",
            scope: "user",
            bytes: promptTokens,
            estimatedTokens: promptTokens,
        }],
    }, {
        kind: "tool_schema",
        id: "tools:read",
        owner: "engine",
        source: "tool",
        displayName: "read",
        count: 1,
        estimatedTokens: toolTokens,
    }];
    for (let position = 0; position < messageCount; position += 1) {
        components.push({
            kind: "message",
            id: `message:${position + 1}`,
            owner: "session",
            source: position % 2 === 0 ? "user" : "assistant",
            displayName: position % 2 === 0 ? "user message" : "assistant message",
            count: 1,
            estimatedTokens: messageTokens[position]!,
        });
    }
    return {
        tokens,
        capacity: 200_000,
        estimated: true,
        projection: { estimatedTokens: tokens, components },
        compaction: { triggerFraction: 0.82, triggerTokens: 164_000 },
    };
}

function contextReport(measurement: ContextMeasurement | undefined) {
    const snapshot: VeraClientContextSnapshot = measurement === undefined
        ? { availability: "unavailable" }
        : {
            availability: "available",
            model: { provider: "faux", model: "test", capacity: 200_000 },
            headline: { tokens: measurement.tokens, estimated: measurement.estimated },
            projection: measurement.projection,
            ...(measurement.compaction === undefined
                ? {}
                : { compaction: measurement.compaction }),
        };
    return buildContextReport(snapshot, true, 120);
}

function counter(): () => string {
    let index = 0;
    return () => `message-${++index}`;
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-context-compaction-"));
    temporaryDirectories.push(directory);
    return directory;
}
