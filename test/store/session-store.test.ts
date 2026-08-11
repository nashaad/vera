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

import {
    SESSION_FORMAT_VERSION,
    readSessionIndexMetadata,
    SessionStore,
} from "../../src/store/session-store.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import type { SessionImageAttachmentMetadata } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("session store creates a header and reloads one message chain", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "session.jsonl");
    const times = dates(
        "2026-07-17T12:00:00.000Z",
        "2026-07-17T12:00:01.000Z",
        "2026-07-17T12:00:02.000Z",
        "2026-07-17T12:00:03.000Z",
    );
    const ids = values("message-1", "message-2", "message-3");
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "hello" }],
    };
    const assistant: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const toolResult: ModelMessage = {
        role: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        presentation: {
            kind: "unified_diff",
            path: "notes.txt",
            patch: "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        },
    };

    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: "/work/vera",
        now: times,
        createId: ids,
    });
    await store.appendMessage(user);
    await store.appendMessage(assistant);
    await store.appendMessage(toolResult);

    expect(readLines(path)).toEqual([
        {
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: "/work/vera",
        },
        {
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-17T12:00:01.000Z",
            message: user,
        },
        {
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-17T12:00:02.000Z",
            message: assistant,
        },
        {
            type: "message",
            id: "message-3",
            parentId: "message-2",
            timestamp: "2026-07-17T12:00:03.000Z",
            message: toolResult,
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.header.id).toBe("session-1");
    expect(reopened.messages()).toEqual([user, assistant, toolResult]);
});

test("startup profile persists in the session header", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "bare.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "bare-session",
        cwd: "/work/vera",
        startupProfile: "bare",
    });

    expect(store.header.startupProfile).toBe("bare");
    expect((await SessionStore.open(path)).header.startupProfile).toBe("bare");
});

test("session index metadata finds a title without loading the store", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "indexed.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "indexed",
        cwd: directory,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "  Find   this conversation  " }],
    });

    expect(await readSessionIndexMetadata(path)).toMatchObject({
        header: { id: "indexed", cwd: directory },
        title: "Find this conversation",
    });
});

test("session origins persist an immutable branch parent edge", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "child.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "child",
        cwd: directory,
        origin: {
            sessionId: "parent",
            entryId: "message-2",
            position: "before",
        },
    });

    expect(store.header.origin).toEqual({
        sessionId: "parent",
        entryId: "message-2",
        position: "before",
    });
    expect((await SessionStore.open(path)).header.origin)
        .toEqual(store.header.origin);
    await expect(SessionStore.create(join(directory, "invalid.jsonl"), {
        sessionId: "invalid",
        cwd: directory,
        origin: {
            sessionId: "",
            entryId: null,
            position: "at",
        },
    })).rejects.toThrow("invalid origin");
});

test("agent failures are durable and idempotent", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "failure.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "failed-session",
        cwd: "/work/vera",
        now: dates(
            "2026-07-22T19:00:00.000Z",
            "2026-07-22T19:01:00.000Z",
        ),
    });
    const failure = await store.appendAgentFailure(
        "failure-1",
        "Resident agent stopped unexpectedly",
    );
    expect(await store.appendAgentFailure(
        "failure-1",
        "Resident agent stopped unexpectedly",
    )).toEqual(failure);
    await expect(store.appendAgentFailure("failure-2", "different"))
        .rejects.toThrow("different agent failure");
    await expect(store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "too late" }],
    })).rejects.toThrow("Cannot append after the terminal agent failure");

    expect((await SessionStore.open(path)).agentFailure()).toEqual(failure);
    expect(readLines(path).filter((entry) => entry.type === "agent_failure"))
        .toHaveLength(1);

    appendFileSync(path, `${JSON.stringify({
        ...failure,
        timestamp: "2026-07-22T19:02:00.000Z",
    })}\n`);
    expect((await SessionStore.open(path)).agentFailure()).toEqual(failure);
});

test("session store ignores removed file checkpoint records", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "keep the conversation" }],
    };
    const assistant: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "kept" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-19T12:00:01.000Z",
            message: user,
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T12:00:02.000Z",
            checkpointId: "removed-checkpoint",
            path: join(directory, "changed.txt"),
            existedBefore: true,
            tool: "edit",
            userMessageId: "message-1",
            beforeSha256: "a".repeat(64),
            afterSha256: "b".repeat(64),
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-19T12:00:03.000Z",
            message: assistant,
        }),
        "",
    ].join("\n"));

    const reopened = await SessionStore.open(path);

    expect(reopened.messages()).toEqual([user, assistant]);
    expect(reopened.entries()).toHaveLength(2);
});

test("session store rejects malformed removed checkpoint records", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T12:00:01.000Z",
            checkpointId: "broken-checkpoint",
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 is not a valid removed checkpoint entry",
    );
});

test("session store serializes concurrent appends into one chain", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
        ),
        createId: values("message-1", "message-2"),
    });
    const first: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first" }],
    };
    const second: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second" }],
    };

    await Promise.all([
        store.appendMessage(first),
        store.appendMessage(second),
    ]);

    expect(store.entries().map((entry) => entry.parentId)).toEqual([
        null,
        "message-1",
    ]);
    expect((await SessionStore.open(path)).messages()).toEqual([first, second]);
});

test("conversation rewind keeps the physical tail and survives restart", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const firstUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first request" }],
    };
    const firstAssistant = assistantMessage("first answer");
    const secondUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second request" }],
    };
    const secondAssistant = assistantMessage("second answer");
    const replacementUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "replacement request" }],
    };
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-19T12:00:00.000Z",
            "2026-07-19T12:00:01.000Z",
            "2026-07-19T12:00:02.000Z",
            "2026-07-19T12:00:03.000Z",
            "2026-07-19T12:00:04.000Z",
            "2026-07-19T12:00:05.000Z",
            "2026-07-19T12:00:06.000Z",
        ),
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    await store.appendMessage(firstUser);
    await store.appendMessage(firstAssistant);
    const secondBoundary = await store.appendMessage(secondUser);
    await store.appendMessage(secondAssistant);

    const rewind = await store.rewindBefore(secondBoundary.id);

    expect(rewind).toEqual({
        type: "rewind",
        timestamp: "2026-07-19T12:00:05.000Z",
        userMessageId: "message-3",
        previousHeadId: "message-4",
        headId: "message-2",
    });
    expect(store.activeHeadId()).toBe("message-2");
    expect(store.activeEntries().map((entry) => entry.id)).toEqual([
        "message-1",
        "message-2",
    ]);
    expect(store.messages()).toEqual([firstUser, firstAssistant]);
    expect(store.entries()).toHaveLength(4);
    expect(readLines(path).map((line) => line.type)).toEqual([
        "session",
        "message",
        "message",
        "message",
        "message",
        "rewind",
    ]);
    await expect(store.rewindBefore(secondBoundary.id)).rejects.toThrow(
        "Rewind boundary message-3 is not an active user message",
    );

    const replacement = await store.appendMessage(replacementUser);

    expect(replacement.parentId).toBe("message-2");
    expect(store.messages()).toEqual([
        firstUser,
        firstAssistant,
        replacementUser,
    ]);

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-19T12:00:07.000Z"),
    });
    expect(reopened.header.id).toBe("session-1");
    expect(reopened.activeHeadId()).toBe("message-5");
    expect(reopened.messages()).toEqual([
        firstUser,
        firstAssistant,
        replacementUser,
    ]);
    expect(reopened.entries().map((entry) => entry.id)).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "message-4",
        "message-5",
    ]);

    expect(await reopened.rewindBefore("message-1")).toEqual({
        type: "rewind",
        timestamp: "2026-07-19T12:00:07.000Z",
        userMessageId: "message-1",
        previousHeadId: "message-5",
        headId: null,
    });
    const rewoundAgain = await SessionStore.open(path);
    expect(rewoundAgain.activeHeadId()).toBeNull();
    expect(rewoundAgain.messages()).toEqual([]);
    expect(rewoundAgain.entries()).toHaveLength(5);
});

test("session store rejects a rewind record from an inactive head", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-19T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "first request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-19T12:00:02.000Z",
            message: assistantMessage("answer"),
        }),
        JSON.stringify({
            type: "rewind",
            timestamp: "2026-07-19T12:00:03.000Z",
            userMessageId: "message-1",
            previousHeadId: "message-1",
            headId: null,
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 4 rewinds from inactive head message-1",
    );
});

test("session store rejects a message that jumps onto an abandoned tail", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-19T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "first request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-19T12:00:02.000Z",
            message: assistantMessage("answer"),
        }),
        JSON.stringify({
            type: "rewind",
            timestamp: "2026-07-19T12:00:03.000Z",
            userMessageId: "message-1",
            previousHeadId: "message-2",
            headId: null,
        }),
        JSON.stringify({
            type: "message",
            id: "message-3",
            parentId: "message-2",
            timestamp: "2026-07-19T12:00:04.000Z",
            message: assistantMessage("jumped back"),
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 5 does not extend the active head",
    );
});

test("model settings records restore the latest complete selection", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
        ),
    });

    await store.appendModelSettings({
        model: "first-model",
        reasoningEffort: "high",
    });
    await store.appendModelSettings({ model: "second-model" });

    expect(store.modelSettings()).toEqual({ model: "second-model" });
    expect(readLines(path).slice(1)).toEqual([
        {
            type: "model_settings",
            timestamp: "2026-07-17T12:00:01.000Z",
            settings: {
                model: "first-model",
                reasoningEffort: "high",
            },
        },
        {
            type: "model_settings",
            timestamp: "2026-07-17T12:00:02.000Z",
            settings: { model: "second-model" },
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.modelSettings()).toEqual({ model: "second-model" });
    expect(reopened.messages()).toEqual([]);
});

test("model settings persist the provider and survive reopening", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
        ),
    });

    await store.appendModelSettings({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
    });

    expect(readLines(path).slice(1)).toEqual([
        {
            type: "model_settings",
            timestamp: "2026-07-17T12:00:01.000Z",
            settings: {
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                reasoningEffort: "medium",
            },
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.modelSettings()).toEqual({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
    });
});

test("model settings written before providers were persisted stay unrecorded", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    appendFileSync(path, `${JSON.stringify({
        type: "model_settings",
        timestamp: "2026-07-17T12:00:01.000Z",
        settings: { model: "legacy-model", reasoningEffort: "high" },
    })}\n`);

    const reopened = await SessionStore.open(path);
    const settings = reopened.modelSettings();
    expect(settings).toEqual({
        model: "legacy-model",
        reasoningEffort: "high",
    });
    // The resume path distinguishes an unrecorded provider from a recorded
    // one, so the key must be absent rather than present and undefined.
    expect(Object.keys(settings ?? {})).not.toContain("provider");
});

test("session store rejects invalid model settings before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendModelSettings({ model: "" })).rejects.toThrow(
        "Cannot append invalid model settings",
    );
    await expect(store.appendModelSettings({
        model: "test",
        reasoningEffort: "",
    } as unknown as ModelTurnSettings)).rejects.toThrow(
        "Cannot append invalid model settings",
    );
    expect(readLines(path)).toHaveLength(1);
});

test("session names are append-only and clearing restores the fallback", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-23T12:00:00.000Z",
            "2026-07-23T12:00:01.000Z",
            "2026-07-23T12:00:02.000Z",
        ),
    });

    await store.appendName("  Release planning  ");
    expect(store.name()).toBe("Release planning");

    await store.appendName(null);
    expect(store.name()).toBeUndefined();
    expect(readLines(path).slice(1)).toEqual([
        {
            type: "session_name",
            timestamp: "2026-07-23T12:00:01.000Z",
            name: "Release planning",
        },
        {
            type: "session_name",
            timestamp: "2026-07-23T12:00:02.000Z",
            name: null,
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.name()).toBeUndefined();
});

test("session names reject empty, oversized, and malformed values", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendName("   ")).rejects.toThrow(
        "Session name must be 1 to 200 UTF-8 bytes",
    );
    await expect(store.appendName("a".repeat(201))).rejects.toThrow(
        "Session name must be 1 to 200 UTF-8 bytes",
    );
    expect(readLines(path)).toHaveLength(1);

    appendFileSync(path, `${JSON.stringify({
        type: "session_name",
        timestamp: "2026-07-23T12:00:01.000Z",
        name: 42,
    })}\n`);
    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 is not a valid session name entry",
    );
});

test("permission records restore the latest mode outside message history", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
        ),
    });

    await store.appendApprovalMode("ask");
    await store.appendApprovalMode("full_access");

    expect(store.approvalMode()).toBe("full_access");
    expect(readLines(path).slice(1)).toEqual([
        {
            type: "permissions",
            timestamp: "2026-07-17T12:00:01.000Z",
            mode: "ask",
        },
        {
            type: "permissions",
            timestamp: "2026-07-17T12:00:02.000Z",
            mode: "full_access",
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.approvalMode()).toBe("full_access");
    expect(reopened.messages()).toEqual([]);
});

test("session store rejects invalid permissions before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendApprovalMode(
        "../always-allow" as "full_access",
    )).rejects.toThrow("Cannot append invalid permissions mode");
    expect(readLines(path)).toHaveLength(1);
});

test("session store migrates the former automatic mode name", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    appendFileSync(path, `${JSON.stringify({
        type: "permissions",
        timestamp: "2026-07-23T12:00:01.000Z",
        mode: "approve_for_me",
    })}\n`);

    expect((await SessionStore.open(path)).approvalMode()).toBe("auto");
});

test("permission grants survive reopening the durable session", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
        ),
        createId: values("grant-1"),
    });

    const proposal = {
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    } as const;
    await store.appendPermissionGrants([proposal]);
    expect(store.permissionGrants()).toEqual([{
        ...proposal,
        id: "grant-1:0",
    }]);
    expect(readLines(path).at(-1)).toEqual({
        type: "permission_grants",
        id: "grant-1",
        timestamp: "2026-07-17T12:00:01.000Z",
        grants: [{ ...proposal, id: "grant-1:0" }],
    });

    const reopened = await SessionStore.open(path);
    expect(reopened.permissionGrants()).toEqual([{
        ...proposal,
        id: "grant-1:0",
    }]);
});

test("revoking a grant appends rather than edits, and outlives a reopen", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-25T12:00:00.000Z",
            "2026-07-25T12:00:01.000Z",
            "2026-07-25T12:00:02.000Z",
        ),
        createId: values("grant-1"),
    });

    const proposal = {
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    } as const;
    await store.appendPermissionGrants([proposal]);
    expect(await store.revokePermissionGrant("grant-1:0")).toBe(true);
    expect(store.permissionGrants()).toEqual([]);

    // The grant entry is still on disk. An append-only log cannot delete it, so
    // the revocation is its own entry that the read subtracts.
    const lines = readLines(path);
    expect(lines.at(-2)).toMatchObject({ type: "permission_grants" });
    expect(lines.at(-1)).toEqual({
        type: "permission_grant_revocation",
        timestamp: "2026-07-25T12:00:02.000Z",
        ids: ["grant-1:0"],
    });

    // The property that matters: a revoked grant must not come back on resume.
    const reopened = await SessionStore.open(path);
    expect(reopened.permissionGrants()).toEqual([]);
});

test("revoking an unknown or already revoked grant writes nothing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        createId: values("grant-1"),
    });
    await store.appendPermissionGrants([{
        kind: "action",
        when: { operation: "git.push" },
        scope: "session",
        lifetime: "session",
    }]);

    expect(await store.revokePermissionGrant("not-a-grant")).toBe(false);
    const afterUnknown = readLines(path).length;
    expect(await store.revokePermissionGrant("grant-1:0")).toBe(true);
    // A client retrying a stale ID must not be able to grow the log.
    expect(await store.revokePermissionGrant("grant-1:0")).toBe(false);
    expect(readLines(path).length).toBe(afterUnknown + 1);
});

test("a revocation naming a migrated-away grant still loads", async () => {
    // Rejecting it would make an old session unopenable over a permission the
    // user had already given up.
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    appendFileSync(path, `${JSON.stringify({
        type: "permission_grant_revocation",
        timestamp: "2026-07-25T12:00:02.000Z",
        ids: ["grant-that-no-longer-exists"],
    })}\n`);

    const store = await SessionStore.open(path);
    expect(store.permissionGrants()).toEqual([]);
});

test("a revocation entry with no IDs is rejected", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    appendFileSync(path, `${JSON.stringify({
        type: "permission_grant_revocation",
        timestamp: "2026-07-25T12:00:02.000Z",
        ids: [],
    })}\n`);

    await expect(SessionStore.open(path)).rejects.toThrow(
        /permission grant revocation entry/,
    );
});

test("legacy claim-shaped grants migrate when the meaning is preserved", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    appendFileSync(path, `${JSON.stringify({
        type: "permission_grants",
        id: "grant-1",
        timestamp: "2026-07-17T12:00:01.000Z",
        grants: [
            {
                id: "grant-1:0",
                kind: "capability",
                when: { capability: "write", pathScope: "workspace" },
                scope: "session",
                lifetime: "session",
            },
            {
                id: "grant-1:1",
                kind: "capability",
                when: { capability: "delete", recursive: true },
                scope: "session",
                lifetime: "session",
            },
            {
                id: "grant-1:2",
                kind: "capability",
                when: { capability: "network", confidence: "exact" },
                scope: "session",
                lifetime: "session",
            },
        ],
    })}\n`);

    expect((await SessionStore.open(path)).permissionGrants()).toEqual([{
        id: "grant-1:0",
        kind: "action",
        when: { verb: "write", scope: "workspace" },
        scope: "session",
        lifetime: "session",
    }]);
});

test("legacy command-prefix records remain readable but grant no authority", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    appendFileSync(path, `${JSON.stringify({
        type: "command_prefix",
        timestamp: "2026-07-17T12:00:01.000Z",
        prefix: { tokens: ["git", "push", "origin"] },
    })}\n`);

    expect((await SessionStore.open(path)).permissionGrants()).toEqual([]);
});

test("session store rejects malformed permission grants", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendPermissionGrants([])).rejects.toThrow(
        "Cannot append invalid permission grants",
    );
    expect(readLines(path)).toHaveLength(1);
});

test("pending deliveries are idempotent and survive restart until injected", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const delivery = {
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Async subagent finished: tests pass.",
    };
    const store = await SessionStore.create(path, {
        sessionId: "parent-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
        ),
    });

    expect(await Promise.all([
        store.recordDelivery(delivery),
        store.recordDelivery(delivery),
    ])).toEqual([true, false]);
    expect(store.pendingDeliveries()).toEqual([{
        type: "delivery",
        ...delivery,
        timestamp: "2026-07-17T12:00:01.000Z",
    }]);
    appendFileSync(
        path,
        '{"type":"message","id":"torn","deliveryId":"delivery-1"',
    );

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:02.000Z"),
        createId: values("message-1"),
    });
    expect(reopened.pendingDeliveries()).toHaveLength(1);
    const notification: ModelMessage = {
        role: "user",
        internal: true,
        content: [{ type: "text", text: "background result" }],
    };
    await expect(reopened.appendDeliveryMessage(delivery.id, {
        role: "user",
        content: [{ type: "text", text: "not internal" }],
    })).rejects.toThrow("A delivery message must be an internal user message");
    expect(await reopened.appendDeliveryMessage(
        delivery.id,
        notification,
    )).toEqual({
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "2026-07-17T12:00:02.000Z",
        deliveryId: "delivery-1",
        message: notification,
    });
    await expect(reopened.appendDeliveryMessage(
        delivery.id,
        notification,
    )).rejects.toThrow("Delivery delivery-1 is not pending");
    expect(await reopened.recordDelivery(delivery)).toBe(false);
    await expect(reopened.recordDelivery({
        ...delivery,
        content: "Conflicting result",
    })).rejects.toThrow(
        "Delivery delivery-1 conflicts with its stored payload",
    );
    expect(reopened.pendingDeliveries()).toEqual([]);

    const afterSecondRestart = await SessionStore.open(path);
    expect(afterSecondRestart.pendingDeliveries()).toEqual([]);
    expect(readLines(path).map((line) => line.type)).toEqual([
        "session",
        "delivery",
        "message",
    ]);
});

test("rewind requeues only a delivery abandoned with its message", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const firstUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first request" }],
    };
    const secondUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second request" }],
    };
    const notification: ModelMessage = {
        role: "user",
        internal: true,
        content: [{ type: "text", text: "background result" }],
    };
    const delivery = {
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Async subagent finished.",
    };
    const store = await SessionStore.create(path, {
        sessionId: "parent-1",
        cwd: directory,
        now: dates(
            "2026-07-19T12:00:00.000Z",
            "2026-07-19T12:00:01.000Z",
            "2026-07-19T12:00:02.000Z",
            "2026-07-19T12:00:03.000Z",
            "2026-07-19T12:00:04.000Z",
            "2026-07-19T12:00:05.000Z",
            "2026-07-19T12:00:06.000Z",
            "2026-07-19T12:00:07.000Z",
            "2026-07-19T12:00:08.000Z",
        ),
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    const firstBoundary = await store.appendMessage(firstUser);
    await store.appendMessage(assistantMessage("first answer"));
    await store.recordDelivery(delivery);
    await store.appendDeliveryMessage(delivery.id, notification);
    const secondBoundary = await store.appendMessage(secondUser);
    await store.appendMessage(assistantMessage("second answer"));

    expect(store.pendingDeliveries()).toEqual([]);
    await store.rewindBefore(secondBoundary.id);
    expect(store.pendingDeliveries()).toEqual([]);

    await store.rewindBefore(firstBoundary.id);
    const rewound = await SessionStore.open(path, {
        now: dates("2026-07-19T12:00:09.000Z"),
        createId: values("message-6"),
    });
    expect(rewound.pendingDeliveries()).toEqual([{
        type: "delivery",
        ...delivery,
        timestamp: "2026-07-19T12:00:03.000Z",
    }]);

    const reinjected = await rewound.appendDeliveryMessage(
        delivery.id,
        notification,
    );
    expect(reinjected.parentId).toBeNull();
    expect(reinjected.deliveryId).toBe(delivery.id);
    expect(rewound.pendingDeliveries()).toEqual([]);

    const reopened = await SessionStore.open(path);
    expect(reopened.pendingDeliveries()).toEqual([]);
    expect(reopened.activeEntries().map((entry) => entry.id)).toEqual([
        "message-6",
    ]);
    expect(reopened.entries()).toHaveLength(6);
});

test("session store still reads legacy delivery receipts", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "parent-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "delivery",
            id: "delivery-1",
            sourceAgentId: "background-1",
            content: "Finished.",
            timestamp: "2026-07-17T12:00:01.000Z",
        }),
        JSON.stringify({
            type: "delivery_receipt",
            deliveryId: "delivery-1",
            timestamp: "2026-07-17T12:00:02.000Z",
        }),
        "",
    ].join("\n"));

    expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
});

test("rewind requeues a legacy receipt linked by its record position", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const notification: ModelMessage = {
        role: "user",
        internal: true,
        content: [{ type: "text", text: "old background result" }],
    };
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "parent-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-17T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "first request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-17T12:00:02.000Z",
            message: assistantMessage("first answer"),
        }),
        JSON.stringify({
            type: "delivery",
            id: "delivery-1",
            sourceAgentId: "background-1",
            content: "Finished.",
            timestamp: "2026-07-17T12:00:03.000Z",
        }),
        JSON.stringify({
            type: "message",
            id: "message-3",
            parentId: "message-2",
            timestamp: "2026-07-17T12:00:04.000Z",
            message: notification,
        }),
        JSON.stringify({
            type: "delivery_receipt",
            deliveryId: "delivery-1",
            timestamp: "2026-07-17T12:00:05.000Z",
        }),
        JSON.stringify({
            type: "message",
            id: "message-4",
            parentId: "message-3",
            timestamp: "2026-07-17T12:00:06.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "second request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-5",
            parentId: "message-4",
            timestamp: "2026-07-17T12:00:07.000Z",
            message: assistantMessage("second answer"),
        }),
        JSON.stringify({
            type: "rewind",
            timestamp: "2026-07-17T12:00:08.000Z",
            userMessageId: "message-1",
            previousHeadId: "message-5",
            headId: null,
        }),
        "",
    ].join("\n"));

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:09.000Z"),
        createId: values("message-6"),
    });
    expect(reopened.pendingDeliveries()).toHaveLength(1);
    await reopened.appendDeliveryMessage("delivery-1", notification);
    expect(reopened.pendingDeliveries()).toEqual([]);
    expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
});

test("session store removes one unterminated crash fragment before appending", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "kept" }],
    };
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates("2026-07-17T12:00:00.000Z", "2026-07-17T12:00:01.000Z"),
        createId: values("message-1"),
    });
    await store.appendMessage(user);
    appendFileSync(path, '{"type":"message","id":"torn');

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:02.000Z"),
        createId: values("message-2"),
    });
    expect(reopened.messages()).toEqual([user]);
    await reopened.appendMessage({
        role: "user",
        content: [{ type: "text", text: "after restart" }],
    });

    expect(readLines(path).map((line) => line.type)).toEqual([
        "session",
        "message",
        "message",
    ]);
    expect(readFileSync(path, "utf8")).not.toContain('"id":"torn');
});

test("session store rejects malformed complete entries", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: "missing",
            timestamp: "2026-07-17T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "hello" }],
            },
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 references missing parent missing",
    );
});

test("session store rejects invalid delivery message links", async () => {
    const directory = temporaryDirectory();
    const header = {
        type: "session",
        version: SESSION_FORMAT_VERSION,
        id: "session-1",
        timestamp: "2026-07-17T12:00:00.000Z",
        cwd: directory,
    };
    const delivery = {
        type: "delivery",
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Finished.",
        timestamp: "2026-07-17T12:00:01.000Z",
    };
    const notification = {
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "2026-07-17T12:00:02.000Z",
        deliveryId: "delivery-1",
        message: {
            role: "user",
            internal: true,
            content: [{ type: "text", text: "background result" }],
        },
    };
    const cases = [
        {
            name: "missing-delivery",
            records: [notification],
            error: "line 2 references missing delivery delivery-1",
        },
        {
            name: "non-internal",
            records: [
                delivery,
                {
                    ...notification,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "not internal" }],
                    },
                },
            ],
            error: "line 3 has a non-internal delivery message",
        },
        {
            name: "active-duplicate",
            records: [
                delivery,
                notification,
                {
                    ...notification,
                    id: "message-2",
                    parentId: "message-1",
                    timestamp: "2026-07-17T12:00:03.000Z",
                },
            ],
            error: "line 4 repeats active delivery delivery-1",
        },
    ];

    for (const candidate of cases) {
        const path = join(directory, `${candidate.name}.jsonl`);
        writeFileSync(path, [
            JSON.stringify(header),
            ...candidate.records.map((record) => JSON.stringify(record)),
            "",
        ].join("\n"));
        await expect(SessionStore.open(path)).rejects.toThrow(candidate.error);
    }
});

test("session store rejects messages that only resemble engine types", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-17T12:00:01.000Z",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
                source: {},
                usage: {},
                stopReason: "invented",
            },
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 is not a valid message entry",
    );
});

test("attachment metadata is durable, bounded, and idempotent", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-22T12:00:00.000Z",
            "2026-07-22T12:00:01.000Z",
        ),
    });
    const attachment = imageAttachment();
    const expected = { ...attachment };

    const append = store.appendAttachment(attachment);
    (attachment as { name: string }).name = "mutated.png";
    expect(await append).toEqual(expected);
    expect(await store.appendAttachment({
        ...expected,
        name: "same-bytes-different-name.png",
    })).toEqual(expected);
    expect(readLines(path).at(-1)).toEqual({
        type: "attachment",
        timestamp: "2026-07-22T12:00:01.000Z",
        attachment: expected,
    });

    const reopened = await SessionStore.open(path);
    const loaded = reopened.attachmentRecords();
    expect(loaded).toEqual([expected]);
    (loaded[0] as { name: string }).name = "changed.png";
    expect(reopened.attachmentRecords()).toEqual([expected]);
});

test("user messages may reference only attachment metadata already in the session", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    const attachment = imageAttachment();
    const message: ModelMessage = {
        role: "user",
        content: [
            { type: "text", text: "inspect it" },
            { type: "image_attachment", attachmentId: attachment.id },
        ],
    };

    await expect(store.appendMessage(message)).rejects.toThrow(
        `Image attachment ${attachment.id} is not in this session`,
    );
    await store.appendAttachment(attachment);
    await store.appendMessage(message);

    expect((await SessionStore.open(path)).messages()).toEqual([message]);
});

test("attachment IDs reject conflicting metadata", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    const attachment = imageAttachment();
    await store.appendAttachment(attachment);

    await expect(store.appendAttachment({
        ...attachment,
        width: attachment.width + 1,
    })).rejects.toThrow("conflicts with stored metadata");
    expect(readLines(path)).toHaveLength(2);
});

test("session replay tolerates an identical attachment record after retry", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    const attachment = imageAttachment();
    await store.appendAttachment(attachment);
    const record = readLines(path).at(-1)!;
    appendFileSync(path, `${JSON.stringify({
        ...record,
        timestamp: "2026-07-22T12:00:02.000Z",
    })}\n`);

    expect((await SessionStore.open(path)).attachmentRecords())
        .toEqual([attachment]);
});

test("session store rejects malformed attachment records", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const header = JSON.stringify({
        type: "session",
        version: SESSION_FORMAT_VERSION,
        id: "session-1",
        timestamp: "2026-07-22T12:00:00.000Z",
        cwd: directory,
    });
    const attachment = imageAttachment();
    const candidates = [
        { ...attachment, id: "../outside.png" },
        { ...attachment, name: "/private/source.png" },
        { ...attachment, name: " " },
        { ...attachment, name: "bad\0name.png" },
        { ...attachment, sha256: "not-a-hash" },
        { ...attachment, bytes: 0 },
    ];

    for (const candidate of candidates) {
        writeFileSync(path, `${header}\n${JSON.stringify({
            type: "attachment",
            timestamp: "2026-07-22T12:00:01.000Z",
            attachment: candidate,
        })}\n`);
        await expect(SessionStore.open(path)).rejects.toThrow(
            "line 2 is not a valid attachment entry",
        );
    }
});

test("session store rejects an invalid message before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    const invalid = {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        source: {},
        usage: {},
        stopReason: "invented",
    } as unknown as ModelMessage;

    await expect(store.appendMessage(invalid)).rejects.toThrow(
        "Cannot append an invalid model message",
    );
    expect(readLines(path)).toHaveLength(1);
});

test("a compaction replaces the model context without touching the transcript", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    const first = userMessage("first request");
    const firstAnswer = assistantMessage("first answer");
    const second = userMessage("second request");
    const secondAnswer = assistantMessage("second answer");
    for (const message of [first, firstAnswer, second, secondAnswer]) {
        await store.appendMessage(message);
    }
    const summary = assistantMessage("summary of the first exchange");

    await store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: "message-3",
        projection: [summary],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    });

    // The originals are what the user said, so they stay exactly as recorded;
    // only what the model is sent changes.
    expect(store.messages()).toEqual([first, firstAnswer, second, secondAnswer]);
    expect(store.modelContext()).toEqual([summary, second, secondAnswer]);
    expect((await SessionStore.open(path)).modelContext())
        .toEqual([summary, second, secondAnswer]);
});

test("compacting again summarizes the previous projection's span", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    const thirdUser = userMessage("three");
    const thirdAnswer = assistantMessage("third answer");
    for (const message of [
        userMessage("one"),
        assistantMessage("first answer"),
        userMessage("two"),
        assistantMessage("second answer"),
        thirdUser,
        thirdAnswer,
    ]) {
        await store.appendMessage(message);
    }
    const firstSummary = assistantMessage("summary through one");
    const secondSummary = assistantMessage("summary through two");

    await store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: "message-3",
        projection: [firstSummary],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    });
    await store.appendCompaction({
        boundaryMessageId: "message-4",
        firstRetainedMessageId: "message-5",
        projection: [secondSummary],
        measured: { inputTokens: 30, contextWindow: 1_000, estimated: true },
    });

    // The later record wins without the earlier one being removed: both are
    // still in the file, and a session that rewinds can fall back to the first.
    expect(store.modelContext())
        .toEqual([secondSummary, thirdUser, thirdAnswer]);
    expect((await SessionStore.open(path)).modelContext())
        .toEqual([secondSummary, thirdUser, thirdAnswer]);
});

test("rewinding past the boundary retires the compaction without deleting it", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    const first = userMessage("first request");
    const firstAnswer = assistantMessage("first answer");
    const second = userMessage("second request");
    const secondAnswer = assistantMessage("second answer");
    for (const message of [first, firstAnswer, second, secondAnswer]) {
        await store.appendMessage(message);
    }
    await store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: "message-3",
        projection: [assistantMessage("summary")],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    });

    await store.rewindBefore("message-1");

    expect(store.latestCompaction()).toBeUndefined();
    expect(store.modelContext()).toEqual([]);
    // The record is still on disk. It stopped applying because the history it
    // described is no longer on the active branch, not because it was removed.
    expect(readFileSync(path, "utf8")).toContain("\"type\":\"compaction\"");
    expect((await SessionStore.open(path)).latestCompaction()).toBeUndefined();
});

test("a compaction cannot split a tool call from its result", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    const request = userMessage("read the note");
    const call: ModelMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call-1",
            name: "read",
            input: { path: "note.txt" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const result: ModelMessage = {
        role: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
    };
    for (const message of [request, call, result]) {
        await store.appendMessage(message);
    }

    // Retaining the result alone would send a provider an answer to a call it
    // cannot see, which it rejects outright.
    await expect(store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: "message-3",
        projection: [assistantMessage("summary")],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    })).rejects.toThrow("retains a tool result");

    await expect(store.appendCompaction({
        boundaryMessageId: "message-1",
        firstRetainedMessageId: null,
        projection: [call],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    })).rejects.toThrow("leaves tool call call-1 unanswered");
});

test("a compaction record cannot cross a model-context barrier", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    await store.appendMessage(userMessage("inherited"));
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "boundary" }],
        internal: true,
        compactionBarrier: true,
    });
    await store.appendMessage(userMessage("side request"));

    await expect(store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: "message-3",
        projection: [assistantMessage("invalid summary")],
        measured: { inputTokens: 20, estimated: true },
    })).rejects.toThrow("cannot cross a model-context barrier");

    await store.appendCompaction({
        boundaryMessageId: "message-1",
        firstRetainedMessageId: "message-2",
        projection: [assistantMessage("inherited summary")],
        measured: { inputTokens: 20, estimated: true },
    });
    expect(store.modelContext().map((message) => message.content.flatMap(
        (content) => content.type === "text" ? [content.text] : [],
    ).join("\n")))
        .toEqual(["inherited summary", "boundary", "side request"]);
});

test("a compaction is refused unless its anchors are on the active branch", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    await store.appendMessage(userMessage("first request"));
    await store.appendMessage(assistantMessage("first answer"));
    const measured = { inputTokens: 40, contextWindow: 1_000, estimated: true };

    await expect(store.appendCompaction({
        boundaryMessageId: "message-9",
        firstRetainedMessageId: null,
        projection: [assistantMessage("summary")],
        measured,
    })).rejects.toThrow("is not an active message");
    await expect(store.appendCompaction({
        boundaryMessageId: "message-1",
        firstRetainedMessageId: null,
        projection: [assistantMessage("summary")],
        measured,
    })).rejects.toThrow("must retain the message following its boundary");
    await expect(store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: null,
        projection: [],
        measured,
    })).rejects.toThrow("cannot be empty");
    await expect(store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: null,
        projection: [assistantMessage("summary")],
        measured: { inputTokens: 40, contextWindow: 0, estimated: true },
    })).rejects.toThrow("not a usable reading");
    // NaN survives as a number in memory but serializes to null, which the
    // loader rejects, so accepting it would write a session that cannot open.
    await expect(store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: null,
        projection: [{
            ...(assistantMessage("summary") as ModelMessage & {
                role: "assistant";
            }),
            usage: { ...emptyUsage(), inputTokens: Number.NaN },
        }],
        measured,
    })).rejects.toThrow("invalid message");
    // The projection outlives the strategy that made it, so a reference to an
    // attachment the session never stored would fail on every later turn.
    await expect(store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: null,
        projection: [{
            role: "user",
            content: [{ type: "image_attachment", attachmentId: "missing" }],
        }],
        measured,
    })).rejects.toThrow("not in this session");
});

test("a session carrying an unreadable compaction does not load", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    await store.appendMessage(userMessage("first request"));
    appendFileSync(
        path,
        `${JSON.stringify({
            type: "compaction",
            id: "compaction-1",
            timestamp: "2026-07-28T12:00:00.000Z",
            boundaryMessageId: "message-1",
            firstRetainedMessageId: null,
            projection: [],
            measured: { inputTokens: 1, contextWindow: 2, estimated: true },
        })}\n`,
    );

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 3 is not a valid compaction entry",
    );
});

test("turns after a compaction are still sent to the model", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    const first = userMessage("first request");
    const firstAnswer = assistantMessage("first answer");
    for (const message of [first, firstAnswer]) {
        await store.appendMessage(message);
    }
    const summary = assistantMessage("summary of the first exchange");
    await store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: null,
        projection: [summary],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    });

    const next = userMessage("second request");
    const nextAnswer = assistantMessage("second answer");
    for (const message of [next, nextAnswer]) {
        await store.appendMessage(message);
    }

    // A record describes its prefix. Everything said after it is still owed to
    // the model, including messages that did not exist when it was written.
    expect(store.modelContext()).toEqual([summary, next, nextAnswer]);
    expect((await SessionStore.open(path)).modelContext())
        .toEqual([summary, next, nextAnswer]);
});

test("a compaction cannot leave a gap between its boundary and its suffix", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await countedStore(path, directory);
    for (const message of [
        userMessage("one"),
        assistantMessage("first answer"),
        userMessage("two"),
        assistantMessage("second answer"),
    ]) {
        await store.appendMessage(message);
    }

    // Retaining from message-3 while compacting only through message-1 would
    // drop message-2 with nothing recording that it went missing.
    await expect(store.appendCompaction({
        boundaryMessageId: "message-1",
        firstRetainedMessageId: "message-3",
        projection: [assistantMessage("summary")],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    })).rejects.toThrow("must retain the message following its boundary");
});


async function countedStore(
    path: string,
    cwd: string,
): Promise<SessionStore> {
    let sequence = 0;
    return await SessionStore.create(path, {
        sessionId: "session-1",
        cwd,
        now: () => new Date("2026-07-28T12:00:00.000Z"),
        createId: () => {
            sequence += 1;
            return `message-${sequence}`;
        },
    });
}

function userMessage(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-store-"));
    temporaryDirectories.push(directory);
    return directory;
}

function assistantMessage(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function imageAttachment(): SessionImageAttachmentMetadata {
    const sha256 = "a".repeat(64);
    return {
        id: `${sha256}.png`,
        name: "screenshot.png",
        mediaType: "image/png",
        bytes: 123,
        width: 10,
        height: 20,
        sha256,
    };
}

function readLines(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dates(...timestamps: string[]): () => Date {
    const next = values(...timestamps);
    return () => new Date(next());
}

function values<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) {
            throw new Error("No scripted value remains");
        }
        return item;
    };
}
