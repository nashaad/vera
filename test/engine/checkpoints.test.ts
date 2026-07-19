import { afterAll, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    checkpointChainStatus,
    listCheckpoints,
    planBoundaryFileRestore,
    restoreCheckpoint,
} from "../../src/engine/checkpoints.ts";
import {
    CheckpointStore,
    sha256Text,
} from "../../src/store/checkpoint-store.ts";
import {
    SessionStore,
    SESSION_FORMAT_VERSION,
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

test("boundary planning restores the earliest state after repeated edits", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "gamma");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "alpha",
        after: "beta",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "beta",
        after: "gamma",
    });

    expect(await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    )).toEqual({
        boundaryId: "user-message-1",
        applicable: true,
        files: [{
            path: filePath,
            checkpointId: "checkpoint-1",
            mutationCount: 2,
            status: "clean",
            action: "restore",
        }],
    });
});

test("boundary planning reports an already restored file as a no-op", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "alpha");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "alpha",
        after: "beta",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(true);
    expect(plan.files[0]).toMatchObject({
        status: "already_restored",
        action: "none",
    });
});

test("boundary planning distinguishes changed, missing, and unexpected paths", async () => {
    const directory = temporaryDirectory();
    const changedPath = join(directory, "changed.txt");
    const missingPath = join(directory, "missing.txt");
    const unexpectedPath = join(directory, "created.txt");
    writeFileSync(changedPath, "human change");
    writeFileSync(unexpectedPath, "replacement");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: changedPath,
        existedBefore: true,
        tool: "edit",
        before: "old",
        after: "agent change",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: missingPath,
        existedBefore: true,
        tool: "edit",
        before: "old",
        after: "agent change",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-3",
        path: unexpectedPath,
        existedBefore: false,
        tool: "write",
        after: "agent creation",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files.map((file) => [file.path, file.status])).toEqual([
        [changedPath, "changed"],
        [missingPath, "missing"],
        [unexpectedPath, "unexpected"],
    ]);
});

test("boundary planning treats an absent created file as already restored", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "created.txt");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: false,
        tool: "write",
        after: "agent creation",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.files[0]).toMatchObject({
        status: "already_restored",
        action: "none",
    });
});

test("boundary planning rejects a broken chain even when the live file matches", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "gamma");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "alpha",
        after: "beta",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "human change",
        after: "gamma",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files[0]?.status).toBe("intervening_change");
});

test("an already restored target remains a no-op when its old chain is broken", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "alpha");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "alpha",
        after: "beta",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "human change",
        after: "gamma",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(true);
    expect(plan.files[0]).toMatchObject({
        status: "already_restored",
        action: "none",
    });
});

test("boundary planning rejects a corrupt target blob", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "agent change");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "old",
        after: "agent change",
    });
    writeFileSync(
        join(directory, "checkpoints", "checkpoint-1.json"),
        `${JSON.stringify({ existed: true, content: "wrong target" })}\n`,
    );

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files[0]?.status).toBe("unreadable");
});

test("boundary planning validates every blob in a repeated-edit chain", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "gamma");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "alpha",
        after: "beta",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "beta",
        after: "gamma",
    });
    writeFileSync(
        join(directory, "checkpoints", "checkpoint-2.json"),
        "not json\n",
    );

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files[0]?.status).toBe("unreadable");
});

test("boundary planning never follows a replacement symbolic link", async () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, "note.txt");
    const outsidePath = join(temporaryDirectory(), "outside.txt");
    writeFileSync(outsidePath, "agent change");
    symlinkSync(outsidePath, filePath);
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: filePath,
        existedBefore: true,
        tool: "edit",
        before: "old",
        after: "agent change",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files[0]?.status).toBe("unexpected");
});

test("boundary planning rejects a relative stored checkpoint path", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "note.txt"), "agent change");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: "note.txt",
        existedBefore: true,
        tool: "edit",
        before: "old",
        after: "agent change",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files[0]?.status).toBe("unexpected");
});

test("boundary planning excludes checkpoints before the selected user message", async () => {
    const directory = temporaryDirectory();
    const earlierPath = join(directory, "earlier.txt");
    const selectedPath = join(directory, "selected.txt");
    writeFileSync(earlierPath, "earlier agent change");
    writeFileSync(selectedPath, "selected agent change");
    const createId = identifiers("user-message-1", "user-message-2");
    const { store, checkpoints } = await fixture(directory, createId);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: earlierPath,
        existedBefore: true,
        tool: "edit",
        before: "earlier target",
        after: "earlier agent change",
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "second change" }],
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: selectedPath,
        existedBefore: true,
        tool: "edit",
        userMessageId: "user-message-2",
        before: "selected target",
        after: "selected agent change",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-2",
    );
    expect(plan.files).toEqual([{
        path: selectedPath,
        checkpointId: "checkpoint-2",
        mutationCount: 1,
        status: "clean",
        action: "restore",
    }]);
});

test("one unsafe path makes the complete boundary plan inapplicable", async () => {
    const directory = temporaryDirectory();
    const cleanPath = join(directory, "clean.txt");
    const changedPath = join(directory, "changed.txt");
    writeFileSync(cleanPath, "agent clean");
    writeFileSync(changedPath, "human change");
    const { store, checkpoints } = await fixture(directory);
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-1",
        path: cleanPath,
        existedBefore: true,
        tool: "edit",
        before: "old clean",
        after: "agent clean",
    });
    await addCheckpoint(store, checkpoints, {
        checkpointId: "checkpoint-2",
        path: changedPath,
        existedBefore: true,
        tool: "edit",
        before: "old changed",
        after: "agent changed",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files.map((file) => file.status)).toEqual(["clean", "changed"]);
    expect(readFileSync(cleanPath, "utf8")).toBe("agent clean");
    expect(readFileSync(changedPath, "utf8")).toBe("human change");
});

test("legacy checkpoints block a boundary plan as unverifiable", async () => {
    const directory = temporaryDirectory();
    const sessionPath = join(directory, "session.jsonl");
    const filePath = join(directory, "note.txt");
    writeFileSync(filePath, "agent change");
    writeFileSync(sessionPath, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T00:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "user-message-1",
            parentId: null,
            timestamp: "2026-07-19T00:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "change the file" }],
            },
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T00:00:02.000Z",
            checkpointId: "checkpoint-1",
            path: filePath,
            existedBefore: true,
            tool: "edit",
        }),
        "",
    ].join("\n"));
    const store = await SessionStore.open(sessionPath);
    const checkpoints = new CheckpointStore(join(directory, "checkpoints"));

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-1",
    );
    expect(plan.applicable).toBe(false);
    expect(plan.files[0]?.status).toBe("unverifiable");
});

test("a legacy checkpoint before the selected boundary does not hide later work", async () => {
    const directory = temporaryDirectory();
    const sessionPath = join(directory, "session.jsonl");
    const legacyPath = join(directory, "legacy.txt");
    const selectedPath = join(directory, "selected.txt");
    writeFileSync(legacyPath, "legacy change");
    writeFileSync(selectedPath, "selected change");
    writeFileSync(sessionPath, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T00:00:00.000Z",
            cwd: directory,
        }),
        messageRecord("user-message-1", null, "first change"),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T00:00:02.000Z",
            checkpointId: "legacy-checkpoint",
            path: legacyPath,
            existedBefore: true,
            tool: "edit",
        }),
        messageRecord("user-message-2", "user-message-1", "second change"),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T00:00:04.000Z",
            checkpointId: "selected-checkpoint",
            path: selectedPath,
            existedBefore: true,
            tool: "edit",
            userMessageId: "user-message-2",
            beforeSha256: sha256Text("selected target"),
            afterSha256: sha256Text("selected change"),
        }),
        "",
    ].join("\n"));
    const store = await SessionStore.open(sessionPath);
    const checkpoints = new CheckpointStore(join(directory, "checkpoints"));
    await checkpoints.write("selected-checkpoint", {
        existed: true,
        content: "selected target",
    });

    const plan = await planBoundaryFileRestore(
        store,
        checkpoints,
        "user-message-2",
    );
    expect(plan.applicable).toBe(true);
    expect(plan.files).toEqual([{
        path: selectedPath,
        checkpointId: "selected-checkpoint",
        mutationCount: 1,
        status: "clean",
        action: "restore",
    }]);
});

test("boundary planning rejects an unknown user-message id", async () => {
    const directory = temporaryDirectory();
    const { store, checkpoints } = await fixture(directory);
    await expect(planBoundaryFileRestore(
        store,
        checkpoints,
        "missing-user-message",
    )).rejects.toThrow("Unknown user-message boundary");
});

async function fixture(
    directory: string,
    createId: () => string = () => "user-message-1",
): Promise<{ store: SessionStore; checkpoints: CheckpointStore }> {
    const store = await SessionStore.create(
        join(directory, "session.jsonl"),
        {
            sessionId: "session-1",
            cwd: directory,
            createId,
        },
    );
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "change the files" }],
    });
    const checkpoints = new CheckpointStore(join(directory, "checkpoints"));
    return { store, checkpoints };
}

async function addCheckpoint(
    store: SessionStore,
    checkpoints: CheckpointStore,
    input: CheckpointFixture,
): Promise<void> {
    await checkpoints.write(input.checkpointId, {
        existed: input.existedBefore,
        content: input.before ?? "",
    });
    await store.appendCheckpoint(checkpoint(input));
}

interface CheckpointFixture {
    readonly checkpointId: string;
    readonly path: string;
    readonly existedBefore: boolean;
    readonly tool: "write" | "edit";
    readonly userMessageId?: string;
    readonly before?: string;
    readonly after: string;
}

function checkpoint(input: CheckpointFixture): NewSessionCheckpoint {
    return {
        checkpointId: input.checkpointId,
        path: input.path,
        existedBefore: input.existedBefore,
        tool: input.tool,
        userMessageId: input.userMessageId ?? "user-message-1",
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
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-checkpoints-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}

function identifiers(...ids: string[]): () => string {
    let index = 0;
    return () => ids[index++] ?? `unexpected-id-${index}`;
}

function messageRecord(
    id: string,
    parentId: string | null,
    text: string,
): string {
    return JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-07-19T00:00:03.000Z",
        message: {
            role: "user",
            content: [{ type: "text", text }],
        },
    });
}
