import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/store/session-store.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

async function createStore(): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-store-exclusive-"));
    directories.push(directory);
    return SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "exclusive",
        cwd: directory,
    });
}

test("an exclusive task sees every earlier append finished and holds back later ones", async () => {
    const store = await createStore();
    const echoed: number[] = [];
    store.watchRecords((line) => echoed.push(line));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const seen: { before: number; during: number; echoedDuring: number }[] = [];

    const earlier = store.appendMessage(user("earlier"));
    const task = store.exclusively(async () => {
        const before = store.appendedLineCount();
        await held;
        seen.push({
            before,
            during: store.appendedLineCount(),
            echoedDuring: echoed.length,
        });
        return "done";
    });
    const later = store.appendMessage(user("later"));

    await Bun.sleep(50);
    expect(store.appendedLineCount()).toBe(2);
    release();

    expect(await task).toBe("done");
    await earlier;
    await later;
    expect(seen).toEqual([{ before: 2, during: 2, echoedDuring: 1 }]);
    expect(echoed).toEqual([2, 3]);
});

test("a failed exclusive task does not block the appends behind it", async () => {
    const store = await createStore();

    const failed = store.exclusively(async () => {
        throw new Error("task failed");
    });
    const after = store.appendMessage(user("after"));

    expect(failed).rejects.toThrow("task failed");
    await after;
    expect(store.appendedLineCount()).toBe(2);
});
