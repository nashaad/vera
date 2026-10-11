import { expect, test } from "bun:test";

import { PromptHistoryTracker } from "../../src/engine/prompt-history-drift.ts";
import type { ModelInputMessage } from "../../src/model/types.ts";

function user(text: string): ModelInputMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): ModelInputMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        source: { provider: "test", model: "crow", api: "test" },
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
    };
}

function toolResult(toolCallId: string, text: string): ModelInputMessage {
    return {
        role: "tool_result",
        toolCallId,
        toolName: "grep",
        content: [{ type: "text", text }],
        isError: false,
    };
}

test("a history that only grows at the end is not drift", () => {
    const tracker = new PromptHistoryTracker();
    const first = [user("chart the reef"), assistant("aye")];
    const lineage = { messageIds: ["u1", "a1"] };

    expect(tracker.observe(first, lineage)).toBeUndefined();
    expect(tracker.observe(
        [...first, user("and the cove")],
        { messageIds: ["u1", "a1", "u2"] },
    )).toBeUndefined();
});

test("an earlier message that changes bytes is unexplained drift", () => {
    const tracker = new PromptHistoryTracker();
    const lineage = { messageIds: ["u1", "a1"] };

    tracker.observe([user("chart the reef"), assistant("aye")], lineage);
    expect(tracker.observe(
        [user("chart the reef at dawn"), assistant("aye")],
        lineage,
    )).toEqual({
        cause: "unexplained",
        changes: [{ index: 0, role: "user", kind: "content_changed" }],
    });
});

test("a tool result rewritten in place by aging is expected", () => {
    const tracker = new PromptHistoryTracker();
    const lineage = { messageIds: ["u1", "a1", "t1"] };

    tracker.observe([
        user("find the parrot"),
        assistant("grepping"),
        toolResult("call-1", "map.ts:3 parrot perch\n".repeat(50)),
    ], lineage);
    expect(tracker.observe([
        user("find the parrot"),
        assistant("grepping"),
        toolResult("call-1", "[vera] 50 matches in map.ts"),
    ], lineage)).toBeUndefined();
});

test("a dropped message is drift unless the lineage moved", () => {
    const tracker = new PromptHistoryTracker();
    tracker.observe(
        [user("raise the flag"), assistant("raised")],
        { messageIds: ["u1", "a1"] },
    );

    expect(tracker.observe([user("raise the flag")], { messageIds: ["u1", "a1"] }))
        .toEqual({
            cause: "unexplained",
            changes: [{ index: 1, role: "assistant", kind: "removed" }],
        });
});

test("compaction and rewind explain a rewritten history", () => {
    const tracker = new PromptHistoryTracker();
    tracker.observe(
        [user("plunder"), assistant("plundered")],
        { messageIds: ["u1", "a1"] },
    );

    expect(tracker.observe(
        [user("summary: the crow plundered"), user("next")],
        { compactionId: "c1", messageIds: ["u1", "a1", "u2"] },
    )).toBeUndefined();
    expect(tracker.observe(
        [user("summary: the crow plundered"), user("instead, nap")],
        { compactionId: "c1", messageIds: ["u1", "a1", "u3"] },
    )).toBeUndefined();
});

test("image bytes are hashed, so a changed image is drift", () => {
    const tracker = new PromptHistoryTracker();
    const lineage = { messageIds: ["u1"] };
    const image = (byte: number): ModelInputMessage => ({
        role: "user",
        content: [{
            type: "image",
            mediaType: "image/png",
            data: Buffer.from([byte, byte, byte]),
        }],
    } as ModelInputMessage);

    tracker.observe([image(1)], lineage);
    expect(tracker.observe([image(1)], lineage)).toBeUndefined();
    expect(tracker.observe([image(2)], lineage)?.changes).toEqual([
        { index: 0, role: "user", kind: "content_changed" },
    ]);
});
