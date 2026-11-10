import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import { buildContextReport } from "../../src/core-extensions/context/context-report.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { readIndexedLiveContext, SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a reloaded session keeps the latest measurement at every rewind point", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "context-measurements",
        cwd: directory,
        createId: counter(),
    });
    const first = await store.appendMessage(user("first"));
    await store.appendContextMeasurement(measurement(100));
    await store.appendMessage(assistant("first answer"));
    await store.appendContextMeasurement(measurement(110));
    const second = await store.appendMessage(user("second"));
    await store.appendContextMeasurement(measurement(200));
    await store.appendMessage(assistant("second answer"));
    await store.appendContextMeasurement(measurement(210));
    const third = await store.appendMessage(user("third"));
    await store.appendContextMeasurement(measurement(300));
    await store.appendMessage(assistant("third answer"));
    await store.appendContextMeasurement(measurement(310));

    const reopened = await SessionStore.open(path);
    expect(reopened.latestContextMeasurement()?.tokens).toBe(310);
    const onBranch = reopened.latestContextMeasurement();
    const initialReport = contextReport(onBranch);
    expect((await readIndexedLiveContext(path)).measurement).toEqual(onBranch);

    const resumed = await SessionStore.open(path);
    expect(resumed.latestContextMeasurement()).toEqual(onBranch);
    expect(contextReport(resumed.latestContextMeasurement())).toEqual(initialReport);

    await resumed.rewindBefore(third.id);
    expect(resumed.latestContextMeasurement()?.tokens).toBe(210);
    expect((await readIndexedLiveContext(path)).measurement).toEqual(resumed.latestContextMeasurement());
    const thirdReport = contextReport(resumed.latestContextMeasurement());
    const resumedAfterThird = await SessionStore.open(path);
    expect(resumedAfterThird.latestContextMeasurement()).toEqual(
        resumed.latestContextMeasurement(),
    );
    expect(contextReport(resumedAfterThird.latestContextMeasurement())).toEqual(thirdReport);

    await resumedAfterThird.rewindBefore(second.id);
    expect(resumedAfterThird.latestContextMeasurement()?.tokens).toBe(110);
    expect((await readIndexedLiveContext(path)).measurement).toEqual(resumedAfterThird.latestContextMeasurement());
    const secondReport = contextReport(resumedAfterThird.latestContextMeasurement());
    const resumedAfterSecond = await SessionStore.open(path);
    expect(resumedAfterSecond.latestContextMeasurement()).toEqual(
        resumedAfterThird.latestContextMeasurement(),
    );
    expect(contextReport(resumedAfterSecond.latestContextMeasurement())).toEqual(secondReport);

    await resumedAfterSecond.rewindBefore(first.id);
    expect(resumedAfterSecond.latestContextMeasurement()).toBeUndefined();
    expect((await readIndexedLiveContext(path)).measurement).toBeUndefined();
    expect(contextReport(resumedAfterSecond.latestContextMeasurement())).toEqual(
        contextReport(undefined),
    );
    expect(onBranch?.tokens).toBe(310);
});

test("every rewind point keeps the answer it had before the session was reloaded", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "long-context-measurements",
        cwd: directory,
        createId: counter(),
    });
    const users: string[] = [];
    for (let index = 0; index < 80; index += 1) {
        const userMessage = await store.appendMessage(user(`question ${index}`));
        users.push(userMessage.id);
        await store.appendContextMeasurement(measurement(index * 2));
        await store.appendMessage(assistant(`answer ${index}`));
        await store.appendContextMeasurement(measurement(index * 2 + 1));
    }

    const reopened = await SessionStore.open(path);
    const retained = (reopened as unknown as {
        projection: { contextMeasurementEntries: unknown[] };
    }).projection.contextMeasurementEntries.length;
    expect(retained).toBeLessThanOrEqual(users.length + 1);
    expect(reopened.latestContextMeasurement()?.tokens).toBe(159);

    for (let index = users.length - 1; index >= 0; index -= 1) {
        await reopened.rewindBefore(users[index]!);
        if (index === 0) {
            expect(reopened.latestContextMeasurement()).toBeUndefined();
        } else {
            expect(reopened.latestContextMeasurement()?.tokens).toBe(index * 2 - 1);
        }
    }
});

test("live appends drop measurements a rewind can no longer reach", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "context-measurements",
        cwd: directory,
        createId: counter(),
    });
    const first = await store.appendMessage(user("first"));
    await store.appendContextMeasurement(measurement(100));
    await store.appendMessage(assistant("first answer"));
    for (let index = 0; index < 40; index += 1) {
        await store.appendMessage(assistant(`note ${index}`));
        await store.appendContextMeasurement(measurement(100 + index));
    }
    const second = await store.appendMessage(user("second"));
    await store.appendContextMeasurement(measurement(500));
    await store.appendMessage(assistant("second answer"));
    await store.appendContextMeasurement(measurement(510));

    await store.rewindBefore(second.id);
    expect(store.latestContextMeasurement()?.tokens).toBe(139);
    await store.rewindBefore(first.id);
    expect(store.latestContextMeasurement()).toBeUndefined();
});

test("a measurement taken before the first message survives a rewind to the start", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "context-measurements",
        cwd: directory,
        createId: counter(),
    });
    await store.appendContextMeasurement(measurement(10));
    const first = await store.appendMessage(user("first"));
    await store.appendMessage(assistant("first answer"));
    await store.appendContextMeasurement(measurement(20));

    await store.rewindBefore(first.id);
    expect(store.latestContextMeasurement()?.tokens).toBe(10);
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

function measurement(tokens: number): ContextMeasurement {
    return {
        tokens,
        estimated: true,
        projection: {
            estimatedTokens: tokens,
            components: [{
                kind: "message",
                id: "message:1",
                owner: "session",
                source: "user",
                displayName: "user message",
                count: 1,
                estimatedTokens: tokens,
            }],
        },
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
    const directory = mkdtempSync(join(tmpdir(), "vera-context-measurements-"));
    temporaryDirectories.push(directory);
    return directory;
}
