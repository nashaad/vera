import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentStore } from "../../src/attachments/store.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { completedBranchDelta, createSessionBranch } from "../../src/store/session-branch.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("fork copies history before one prompt and resets execution authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-fork-store-"));
    const sourcePath = join(root, "source.jsonl");
    const source = await SessionStore.create(sourcePath, {
        sessionId: "source",
        cwd: root,
        createId: values("grant-1", "user-1", "assistant-1", "user-2"),
    });
    await source.appendModelSettings({
        provider: "openrouter",
        model: "test-model",
        reasoningEffort: "high",
    });
    await source.appendApprovalMode("full_access");
    await source.appendPermissionGrants([{
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }]);
    await source.appendName("Source name");
    await source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "first" }],
    });
    await source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    await source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "edit me" }],
    });

    const branch = await createSessionBranch({
        source,
        destinationPath: join(root, "fork.jsonl"),
        sessionId: "fork",
        position: "before",
        entryId: "user-2",
    });

    expect(branch.store.messages()).toEqual(source.messages().slice(0, 2));
    expect(branch.prompt).toEqual({
        role: "user",
        content: [{ type: "text", text: "edit me" }],
    });
    expect(branch.store.header.origin).toEqual({
        sessionId: "source",
        entryId: "user-2",
        position: "before",
    });
    expect(branch.store.modelSettings()).toEqual(source.modelSettings());
    expect(branch.store.approvalMode()).toBeUndefined();
    expect(branch.store.permissionGrants()).toEqual([]);
    expect(branch.store.name()).toBeUndefined();
});

test("clone copies the active branch and referenced attachment bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-clone-store-"));
    const sourcePath = join(root, "source.jsonl");
    const source = await SessionStore.create(sourcePath, {
        sessionId: "source",
        cwd: root,
        createId: values("user-1"),
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stored = await new AttachmentStore(sourcePath).saveImage(bytes, {
        mediaType: "image/png",
        bytes: bytes.byteLength,
        width: 1,
        height: 1,
        sha256,
    }, "source.png");
    await source.appendAttachment(stored);
    await source.appendMessage({
        role: "user",
        content: [
            { type: "text", text: "inspect" },
            { type: "image_attachment", attachmentId: stored.id },
        ],
    });

    const branch = await createSessionBranch({
        source,
        destinationPath: join(root, "clone.jsonl"),
        sessionId: "clone",
        position: "at",
    });

    expect(branch.store.messages()).toEqual(source.messages());
    expect(branch.prompt).toBeUndefined();
    expect(branch.store.header.origin).toEqual({
        sessionId: "source",
        entryId: "user-1",
        position: "at",
    });
    const copied = branch.store.attachmentRecords()[0]!;
    expect(await new AttachmentStore(branch.store.path).readImage(copied))
        .toEqual(bytes);
    expect(await readFile(sourcePath, "utf8")).toContain("\"id\":\"source\"");
});

test("branch sync reads completed messages after its cursor and rejects abandoned cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-sync-store-"));
    const store = await SessionStore.create(join(root, "source.jsonl"), {
        sessionId: "source", cwd: root, createId: values("u1", "a1", "u2", "a2", "u3", "u4", "a4"),
    });
    const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
    const answer = (text: string) => ({
        role: "assistant" as const, content: [{ type: "text" as const, text }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop" as const,
    });
    await store.appendMessage(user("one"));
    await store.appendMessage(answer("first"));
    await store.appendMessage(user("two"));
    await store.appendMessage(answer("second"));
    const trailing = await store.appendMessage(user("unfinished"));
    const delta = await completedBranchDelta(store, "a1");
    expect(delta.status).toBe("ready");
    if (delta.status === "ready") {
        expect(delta.entries.map((entry) => entry.id)).toEqual(["u2", "a2"]);
        expect(delta.turns).toBe(1);
    }
    expect(await completedBranchDelta(store, trailing.id)).toEqual({ status: "stale_cursor" });
    await store.rewindBefore("u2");
    await store.appendMessage(user("replacement"));
    await store.appendMessage(answer("new answer"));
    expect(await completedBranchDelta(store, "a2")).toEqual({ status: "stale_cursor" });
});

function values(...items: string[]): () => string {
    let index = 0;
    return () => items[index++]!;
}
