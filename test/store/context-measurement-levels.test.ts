import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    contextSizeLevelBaseline,
    createContextSizeLevelTracker,
} from "../../src/host/agent-registry/context-size-levels.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a reopened session seeds levels from its stored measurement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-context-levels-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "levels",
        cwd: directory,
    });
    const first = await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "read the map" }],
    });
    await store.appendContextMeasurement({
        tokens: 600,
        capacity: 1_000,
        estimated: true,
        projection: {
            estimatedTokens: 600,
            components: [{
                kind: "message",
                id: "message:1",
                owner: "session",
                source: "user",
                displayName: "user message",
                count: 1,
                estimatedTokens: 600,
            }],
        },
    });

    const reopened = await SessionStore.open(path);
    const stored = reopened.latestContextMeasurement()!;
    const tracker = createContextSizeLevelTracker(
        contextSizeLevelBaseline(stored),
    );
    expect(tracker.observe([0.5], 650, 1_000)).toEqual([]);
    expect(tracker.observe([0.5, 0.7], 750, 1_000)).toEqual([0.7]);

    await reopened.rewindBefore(first.id);
    expect(reopened.latestContextMeasurement()).toBeUndefined();
    const afterRewind = createContextSizeLevelTracker(
        contextSizeLevelBaseline(reopened.latestContextMeasurement()),
    );
    expect(afterRewind.observe([0.5], 600, 1_000)).toEqual([0.5]);
});
