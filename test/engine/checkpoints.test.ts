import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    listCheckpoints,
    restoreCheckpoint,
} from "../../src/engine/checkpoints.ts";
import { CheckpointStore } from "../../src/store/checkpoint-store.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("restoring an edited file rewrites its prior contents", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "changed by the agent");

    const { store, checkpoints } = await fixture(directory);
    await checkpoints.write("checkpoint-1", {
        existed: true,
        content: "original",
    });
    await store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
    });

    const result = await restoreCheckpoint(store, checkpoints, "checkpoint-1");
    expect(result).toEqual({
        checkpointId: "checkpoint-1",
        path: filePath,
        action: "restored",
    });
    expect(readFileSync(filePath, "utf8")).toBe("original");
});

test("restoring an agent-created file removes it", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "new.txt");
    writeFileSync(filePath, "content the agent wrote");

    const { store, checkpoints } = await fixture(directory);
    await checkpoints.write("checkpoint-1", { existed: false, content: "" });
    await store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: false,
        tool: "write",
    });

    const result = await restoreCheckpoint(store, checkpoints, "checkpoint-1");
    expect(result.action).toBe("removed");
    expect(existsSync(filePath)).toBe(false);
});

test("listCheckpoints reports the recorded mutations in order", async () => {
    const directory = temporaryDirectory();
    const { store } = await fixture(directory);
    await store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "a.txt"),
        existedBefore: true,
        tool: "edit",
    });
    await store.appendCheckpoint({
        checkpointId: "checkpoint-2",
        path: join(directory, "b.txt"),
        existedBefore: false,
        tool: "write",
    });

    expect(
        listCheckpoints(store).map((entry) => entry.checkpointId),
    ).toEqual(["checkpoint-1", "checkpoint-2"]);
});

test("restoring an unknown checkpoint throws", async () => {
    const directory = temporaryDirectory();
    const { store, checkpoints } = await fixture(directory);
    await expect(
        restoreCheckpoint(store, checkpoints, "missing"),
    ).rejects.toThrow("Unknown checkpoint missing");
});

test("restoring throws when the entry and blob disagree", async () => {
    const directory = temporaryDirectory();
    const { store, checkpoints } = await fixture(directory);
    await checkpoints.write("checkpoint-1", { existed: false, content: "" });
    await store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
    });
    await expect(
        restoreCheckpoint(store, checkpoints, "checkpoint-1"),
    ).rejects.toThrow("disagrees with its stored blob");
});

async function fixture(
    directory: string,
): Promise<{ store: SessionStore; checkpoints: CheckpointStore }> {
    const store = await SessionStore.create(
        join(directory, "session.jsonl"),
        { sessionId: "session-1", cwd: directory },
    );
    const checkpoints = new CheckpointStore(join(directory, "checkpoints"));
    return { store, checkpoints };
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-checkpoints-"));
    temporaryDirectories.push(directory);
    return directory;
}
