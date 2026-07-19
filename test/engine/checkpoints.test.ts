import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    checkpointChainStatus,
    listCheckpoints,
    restoreCheckpoint,
} from "../../src/engine/checkpoints.ts";
import {
    CheckpointStore,
    sha256Text,
} from "../../src/store/checkpoint-store.ts";
import {
    SessionStore,
    type NewSessionCheckpoint,
    type SessionCheckpointEntry,
} from "../../src/store/session-store.ts";

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
    await store.appendCheckpoint(checkpoint({
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "original",
        after: "changed by the agent",
    }));

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
    await store.appendCheckpoint(checkpoint({
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: false,
        tool: "write",
        after: "content the agent wrote",
    }));

    const result = await restoreCheckpoint(store, checkpoints, "checkpoint-1");
    expect(result.action).toBe("removed");
    expect(existsSync(filePath)).toBe(false);
});

test("listCheckpoints reports the recorded mutations in order", async () => {
    const directory = temporaryDirectory();
    const { store } = await fixture(directory);
    await store.appendCheckpoint(checkpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "a.txt"),
        existedBefore: true,
        tool: "edit",
        before: "a0",
        after: "a1",
    }));
    await store.appendCheckpoint(checkpoint({
        checkpointId: "checkpoint-2",
        path: join(directory, "b.txt"),
        existedBefore: false,
        tool: "write",
        after: "b1",
    }));

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
    await store.appendCheckpoint(checkpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
        before: "original",
        after: "changed",
    }));
    await expect(
        restoreCheckpoint(store, checkpoints, "checkpoint-1"),
    ).rejects.toThrow("disagrees with its stored blob");
});

test("checkpoint chains accept exact repeated edits", () => {
    const path = "/work/note.txt";
    expect(checkpointChainStatus([
        storedCheckpoint("checkpoint-1", path, "alpha", "beta"),
        storedCheckpoint("checkpoint-2", path, "beta", "gamma"),
    ])).toBe("continuous");
});

test("checkpoint chains catch an intervening file change", () => {
    const path = "/work/note.txt";
    expect(checkpointChainStatus([
        storedCheckpoint("checkpoint-1", path, "alpha", "beta"),
        storedCheckpoint("checkpoint-2", path, "human edit", "gamma"),
    ])).toBe("intervening_change");
});

test("legacy checkpoint chains are not treated as safe", () => {
    const legacy: SessionCheckpointEntry = {
        type: "checkpoint",
        timestamp: "2026-07-19T00:00:00.000Z",
        checkpointId: "checkpoint-1",
        path: "/work/note.txt",
        existedBefore: true,
        tool: "edit",
    };
    expect(checkpointChainStatus([legacy])).toBe("unverifiable");
});

async function fixture(
    directory: string,
): Promise<{ store: SessionStore; checkpoints: CheckpointStore }> {
    const store = await SessionStore.create(
        join(directory, "session.jsonl"),
        {
            sessionId: "session-1",
            cwd: directory,
            createId: () => "user-message-1",
        },
    );
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "change the files" }],
    });
    const checkpoints = new CheckpointStore(join(directory, "checkpoints"));
    return { store, checkpoints };
}

interface CheckpointFixture {
    readonly checkpointId: string;
    readonly path: string;
    readonly existedBefore: boolean;
    readonly tool: "write" | "edit";
    readonly before?: string;
    readonly after: string;
}

function checkpoint(input: CheckpointFixture): NewSessionCheckpoint {
    return {
        checkpointId: input.checkpointId,
        path: input.path,
        existedBefore: input.existedBefore,
        tool: input.tool,
        userMessageId: "user-message-1",
        beforeSha256: input.existedBefore
            ? sha256Text(input.before ?? "")
            : null,
        afterSha256: sha256Text(input.after),
    };
}

function storedCheckpoint(
    checkpointId: string,
    path: string,
    before: string,
    after: string,
): SessionCheckpointEntry {
    return {
        type: "checkpoint",
        timestamp: "2026-07-19T00:00:00.000Z",
        ...checkpoint({
            checkpointId,
            path,
            existedBefore: true,
            tool: "edit",
            before,
            after,
        }),
    };
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-checkpoints-"));
    temporaryDirectories.push(directory);
    return directory;
}
