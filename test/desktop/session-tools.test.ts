import { describe, expect, test } from "bun:test";

import { entriesToBlocks, initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import { MAX_CONTEXT_COMPONENTS, type Block, type SessionWatch } from "../../clients/ui/src/session/model.ts";
import { parseSessionLine, type SessionMessage } from "../../clients/ui/src/session/wire.ts";
import {
    applyTimelineCommand,
    compactCommand,
    listTimelineCommand,
    previewRewindCommand,
    tally,
} from "../../clients/ui/src/session/wireTools.ts";
import { compactionNotice, substitutionText, tokenCount } from "../../clients/ui/src/session/notices.ts";

function line(value: unknown): SessionMessage {
    const message = parseSessionLine(JSON.stringify(value));
    if (message === undefined) throw new Error("test line did not parse");
    return message;
}

function blocksOf(entries: readonly unknown[]): Block[] {
    const message = line({ type: "history", entries });
    if (message.type !== "history") throw new Error("expected a history message");
    return entriesToBlocks(message.entries);
}

function fold(values: readonly unknown[], start?: SessionWatch): SessionWatch {
    const attached = start ?? reduceWatch(initialWatch("a1"), line({ type: "attached" }));
    return values.reduce<SessionWatch>((state, value) => reduceWatch(state, line(value)), attached);
}

const PATCH = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n";

describe("commands", () => {
    test("compact and rewind commands are one JSON line each", () => {
        expect(compactCommand("c1")).toBe('{"type":"compact","requestId":"c1"}\n');
        expect(listTimelineCommand("t1")).toBe('{"type":"list_timeline","requestId":"t1"}\n');
        expect(previewRewindCommand("t2", "u9"))
            .toBe('{"type":"preview_timeline_action","requestId":"t2","boundaryId":"u9","action":"rewind_conversation"}\n');
        expect(applyTimelineCommand("t3", "p1")).toBe('{"type":"apply_timeline_action","requestId":"t3","planId":"p1"}\n');
    });
});

describe("presentations", () => {
    test("a patch counts added and removed lines but not its file headers", () => {
        expect(tally(PATCH)).toEqual({ added: 2, removed: 1 });
    });

    test("a stored presentation joins the call whose result came just before it", () => {
        const blocks = blocksOf([
            { kind: "tool", tool: "edit", args: { path: "x.ts" } },
            { kind: "tool", tool: "read", args: { path: "y.ts" } },
            { kind: "tool_result", tool: "edit", output: "ok", isError: false },
            { kind: "presentation", presentation: { kind: "unified_diff", path: "x.ts", patch: PATCH } },
            { kind: "tool_result", tool: "read", output: "text", isError: false },
            { kind: "presentation", presentation: { kind: "checklist", path: "/s/plan.md", items: [{ text: "a", done: true }] } },
        ]);
        const [group] = blocks;
        if (group?.kind !== "tools") throw new Error("expected a tools block");
        expect(group.calls[0]?.presentation).toEqual({
            kind: "diff",
            diff: { path: "x.ts", patch: PATCH, added: 2, removed: 1, scratch: false },
        });
        expect(group.calls[1]?.presentation).toEqual({
            kind: "checklist",
            checklist: { path: "/s/plan.md", items: [{ text: "a", done: true, justDone: false }] },
        });
    });

    test("a live presentation joins the newest finished call of its tool", () => {
        const state = fold([
            { type: "user_prompt", content: "edit" },
            { type: "tool_started", tool: "edit", args: { path: "a.ts" } },
            { type: "tool_finished", tool: "edit", output: "ok" },
            { type: "tool_presentation", tool: "edit", presentation: { kind: "unified_diff", path: "a.ts", patch: PATCH } },
            { type: "tool_started", tool: "edit", args: { path: "b.ts" } },
            { type: "tool_finished", tool: "edit", output: "ok" },
            { type: "tool_presentation", tool: "edit", presentation: { kind: "tool_notice", text: "Too large to show." } },
        ]);
        const group = state.live.find((block) => block.kind === "tools");
        if (group?.kind !== "tools") throw new Error("expected a tools block");
        expect(group.calls.map((call) => call.presentation?.kind)).toEqual(["diff", "tool_notice"]);
    });

    test("a presentation of an unknown kind does not parse", () => {
        expect(parseSessionLine(JSON.stringify({ type: "tool_presentation", tool: "edit", presentation: { kind: "chart" } })))
            .toBeUndefined();
    });
});

describe("notices", () => {
    test("substitutions read like the host's own sentence", () => {
        expect(substitutionText({ model: "m", requested: "big", using: "small", reason: "big is down", scope: "model" }))
            .toBe("Requested model big, ran small instead, because big is down.");
        expect(substitutionText({ model: "m", requested: "max", reason: "m has no levels", scope: "effort" }))
            .toBe('Requested reasoning effort "max" on m, ran with no reasoning level at all, because m has no levels.');
    });

    test("a model failure gives the notice a title and keeps the provider's words", () => {
        const state = fold([
            { type: "user_prompt", content: "hi" },
            {
                type: "turn_finished",
                outcome: "error",
                error: "Request failed.",
                modelFailure: { model: "crow-1", kind: "rate_limit", statusCode: 429, providerMessage: "Slow down", resetsAt: 5000 },
            },
        ]);
        expect(state.live.at(-1)).toEqual({
            kind: "notice",
            key: "l1",
            tone: "error",
            title: "Rate limited (crow-1)",
            text: "Request failed.\nSlow down",
            resetsAt: 5000,
        });
    });

    test("an empty turn and a substitution each leave a row", () => {
        const state = fold([
            { type: "user_prompt", content: "hi" },
            { type: "model_substitution", model: "m", requested: "a", using: "b", reason: "a is down", scope: "model", source: "turn" },
            { type: "turn_finished", empty: true },
        ]);
        expect(state.live.map((block) => block.kind)).toEqual(["user", "substitution", "notice"]);
    });

    test("a delivery parses live and from history", () => {
        const live = fold([{ type: "task_notification", deliveryId: "d1", sourceAgentId: "c1", content: "Found it", kind: "completion" }]);
        expect(live.live).toEqual([{
            kind: "delivery",
            key: "l0",
            deliveryId: "d1",
            sourceAgentId: "c1",
            deliveryKind: "completion",
            text: "Found it",
            fromExtension: false,
        }]);
        const [stored] = blocksOf([
            { kind: "delivery", id: "e1", deliveryId: "d1", sourceAgentId: "c1", deliveryKind: "attention", content: "Look", sourceKind: "extension" },
        ]);
        expect(stored).toMatchObject({ kind: "delivery", deliveryKind: "attention", fromExtension: true, text: "Look" });
    });

    test("a retry shows until the next attempt streams, and can drop the partial text", () => {
        const retrying = fold([
            { type: "user_prompt", content: "hi" },
            { type: "assistant_delta", text: "Half a sen" },
            {
                type: "model_activity",
                phase: "retrying",
                model: "crow-1",
                nextAttempt: 2,
                maxAttempts: 4,
                delayMs: 1000,
                retryAt: "1970-01-01T00:00:05.000Z",
                failure: { kind: "server", statusCode: 502 },
                replacesPartialAttempt: true,
            },
        ]);
        expect(retrying.retry).toEqual({ model: "crow-1", nextAttempt: 2, maxAttempts: 4, retryAt: 5000, failureKind: "server", statusCode: 502 });
        expect(retrying.live.map((block) => block.kind)).toEqual(["user"]);
        const resumed = fold([{ type: "assistant_delta", text: "Whole." }], retrying);
        expect(resumed.retry).toBeUndefined();
    });
});

describe("context, compaction and background work", () => {
    test("a context update keeps the counts and the parts of the request", () => {
        const state = fold([{
            type: "context",
            measurement: {
                tokens: 1200,
                capacity: 32000,
                estimated: true,
                projection: {
                    estimatedTokens: 1100,
                    components: [
                        { kind: "prompt_contribution", id: "p", owner: "core", source: "core", displayName: "Instructions", count: 1, estimatedTokens: 400 },
                        { kind: "tool_schema", id: "t", owner: "core", source: "core", displayName: "read", count: 1, estimatedTokens: 300 },
                        { kind: "message", id: "m1", owner: "core", source: "user", displayName: "User message", count: 1, estimatedTokens: 400 },
                        { kind: "mystery", id: "z", estimatedTokens: 1 },
                    ],
                },
                compaction: { triggerFraction: 0.8, triggerTokens: 25600 },
            },
        }]);
        expect(state.context).toMatchObject({ tokens: 1200, capacity: 32000, estimated: true, projectedTokens: 1100, triggerTokens: 25600, triggerFraction: 0.8 });
        expect(state.context?.components.map((part) => part.kind)).toEqual(["prompt_contribution", "tool_schema", "message"]);
    });

    test("context parts are capped at the newest ones", () => {
        const components = Array.from({ length: MAX_CONTEXT_COMPONENTS + 5 }, (_, index) =>
            ({ kind: "message", id: `m${index}`, source: "user", displayName: "m", estimatedTokens: 1 }));
        const state = fold([{ type: "context", measurement: { tokens: 1, estimated: true, projection: { estimatedTokens: 1, components } } }]);
        expect(state.context?.components.length).toBe(MAX_CONTEXT_COMPONENTS);
        expect(state.context?.components[0]?.id).toBe("m5");
    });

    test("a history checkpoint and a finished turn carry context and usage", () => {
        const usage = { rows: [{ provider: "faux", model: "crow-1", calls: 2, durationMs: 9, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 15 }] };
        const state = fold([
            { type: "history", entries: [], status: "idle", context: { tokens: 50, estimated: false }, usage },
            { type: "turn_finished", usage: { rows: [{ ...usage.rows[0], calls: 3, cost: 0.01 }] } },
        ]);
        expect(state.context?.tokens).toBe(50);
        expect(state.usage).toEqual([{ provider: "faux", model: "crow-1", calls: 3, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15, cost: 0.01 }]);
    });

    test("a finished compaction is kept and leaves a notice", () => {
        const state = fold([
            { type: "compaction", phase: "started", strategy: "summary", trigger: "manual", tokens: 9000 },
            { type: "compaction", phase: "finished", strategy: "summary", outcome: "compacted", before: 9000, after: 1200 },
        ]);
        expect(state.compaction).toEqual({ phase: "finished", outcome: "compacted", tokensBefore: 9000, tokensAfter: 1200 });
        expect(state.live.at(-1)).toMatchObject({ kind: "notice", tone: "info", text: "Compacted the conversation from 9.0K to 1.2K tokens." });
    });

    test("a busy compaction says why it waits", () => {
        expect(compactionNotice({ phase: "finished", outcome: "busy" })?.tone).toBe("warning");
        expect(compactionNotice({ phase: "started" })).toBeUndefined();
    });

    test("background agents come from attached and from their own update", () => {
        const attached = reduceWatch(initialWatch("a1"), line({
            type: "attached",
            background_agents: { running: 1, children: ["Scout"], has_parent: false },
        }));
        expect(attached.background).toEqual({ running: 1, children: ["Scout"], hasParent: false });
        const later = fold([{ type: "background_agents", running: 0, children: [], has_parent: true }], attached);
        expect(later.background).toEqual({ running: 0, children: [], hasParent: true });
    });

    test("token counts read in thousands and millions", () => {
        expect([tokenCount(950), tokenCount(1234), tokenCount(45_600), tokenCount(2_500_000)]).toEqual(["950", "1.2K", "46K", "2.5M"]);
    });
});

describe("rewind replies", () => {
    test("each timeline reply parses into the watch", () => {
        const listed = fold([{
            type: "timeline",
            requestId: "t1",
            boundaries: [
                { userMessageId: "u1", timestamp: "1970-01-01T00:00:01.000Z", prompt: "first", position: 0 },
                { userMessageId: "u2", timestamp: "bad", prompt: "look", attachments: [{ id: "i" }], position: 4 },
                { userMessageId: "u3" },
            ],
        }]);
        expect(listed.timeline).toEqual({
            kind: "list",
            requestId: "t1",
            boundaries: [
                { userMessageId: "u1", timestamp: 1000, prompt: "first", hasImages: false, position: 0 },
                { userMessageId: "u2", prompt: "look", hasImages: true, position: 4 },
            ],
        });
        const boundary = { userMessageId: "u1", timestamp: "1970-01-01T00:00:01.000Z", prompt: "first", position: 0 };
        const previewed = fold([{
            type: "timeline_action_preview",
            requestId: "t2",
            plan: { planId: "p1", expectedHeadId: "h", boundary, keptMessageCount: 0, setAsideMessageCount: 6 },
        }]);
        expect(previewed.timeline).toMatchObject({ kind: "preview", plan: { planId: "p1", keptMessageCount: 0, setAsideMessageCount: 6 } });
        expect(fold([{ type: "timeline_action_applied", requestId: "t3", planId: "p1" }]).timeline)
            .toEqual({ kind: "applied", requestId: "t3", planId: "p1" });
        expect(fold([{ type: "timeline_action_rejected", requestId: "t3", operation: "apply", reason: "plan_expired" }]).timeline)
            .toEqual({ kind: "rejected", requestId: "t3", operation: "apply", reason: "plan_expired" });
    });
});
