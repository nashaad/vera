import { expect, test } from "bun:test";

import {
    MAX_MESSAGE_ENTRY_TOKENS,
    RECENT_ENTRY_LIMIT,
    renderReviewTranscript,
} from "../../src/engine/review-transcript.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistantCall(id: string, command: string): ModelMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id,
            name: "bash",
            input: { command },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function toolResult(id: string, text: string): ModelMessage {
    return {
        role: "tool_result",
        toolCallId: id,
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
    };
}

test("an empty turn renders nothing", () => {
    expect(renderReviewTranscript([])).toEqual({
        text: "",
        signatures: [],
        diverged: false,
    });
});

test("messages, tool calls, and results are numbered in order", () => {
    expect(renderReviewTranscript([
        user("check the build"),
        assistantCall("call_1", "bun test"),
        toolResult("call_1", "3 pass"),
    ]).text).toBe([
        "[1] user: check the build",
        "[2] tool_call bash: {\"command\":\"bun test\"}",
        "[3] tool_result bash: 3 pass",
    ].join("\n"));
});

test("a delta renders only new entries, numbered against the whole turn", () => {
    const messages: ModelMessage[] = [
        user("check the build"),
        assistantCall("call_1", "bun test"),
        toolResult("call_1", "3 pass"),
    ];
    const first = renderReviewTranscript(messages);

    const second = renderReviewTranscript(
        [...messages, assistantCall("call_2", "bun run typecheck")],
        first.signatures,
    );

    // Numbering continues from the first render, so a reviewer that already
    // saw [1]-[3] can place [4] without them being re-sent.
    expect(second.text).toBe("[4] tool_call bash: {\"command\":\"bun run typecheck\"}");
    expect(second.diverged).toBe(false);
    expect(second.signatures.length).toBe(4);
});

test("a rewound turn reports divergence instead of continuing", () => {
    // Counting entries cannot tell a turn that grew from one that was rewound
    // and regrew. Signatures can, and the caller has to know: the entries it
    // was told about no longer exist.
    const authorized: ModelMessage[] = [
        user("clean up the repo"),
        user("yes, force push it"),
        assistantCall("call_1", "git push --force origin main"),
    ];
    const first = renderReviewTranscript(authorized);

    const rewound = renderReviewTranscript(
        [user("clean up the repo"), assistantCall("call_2", "git status")],
        first.signatures,
    );

    expect(rewound.diverged).toBe(true);
});

test("a turn that only grows does not report divergence", () => {
    const messages: ModelMessage[] = [user("check the build")];
    const first = renderReviewTranscript(messages);

    const grown = renderReviewTranscript(
        [...messages, assistantCall("call_1", "bun test")],
        first.signatures,
    );

    expect(grown.diverged).toBe(false);
});

test("a delta with nothing new renders nothing", () => {
    const messages: ModelMessage[] = [user("check the build")];
    const first = renderReviewTranscript(messages);

    const second = renderReviewTranscript(messages, first.signatures);

    expect(second.text).toBe("");
    expect(second.diverged).toBe(false);
});

test("the first and last user turns survive a long turn", () => {
    const messages: ModelMessage[] = [user("deploy the staging service")];
    for (let index = 0; index < RECENT_ENTRY_LIMIT + 20; index += 1) {
        messages.push(assistantCall(`call_${index}`, `step ${index}`));
    }
    messages.push(user("yes, go ahead"));

    const rendered = renderReviewTranscript(messages).text;

    // The original ask is what authorization is scored against, so recency
    // must not be allowed to push it out.
    expect(rendered).toContain("user: deploy the staging service");
    expect(rendered).toContain("user: yes, go ahead");
    expect(rendered).toContain('<omitted entries="20" reason="length" />');
    expect(rendered).not.toContain("step 5\"");
});

test("every user turn that fits survives, not just the first and last", () => {
    // Authorization is scored against user turns, so a middle turn that grants
    // permission must not lose its slot to tool output. Codex keeps all user
    // turns that fit the message budget and only then spends the recency limit
    // on everything else.
    const messages: ModelMessage[] = [
        user("clean up the repo"),
        user("yes, force pushing that branch is fine"),
        user("also update the changelog"),
    ];
    for (let index = 0; index < RECENT_ENTRY_LIMIT + 20; index += 1) {
        messages.push(assistantCall(`call_${index}`, `step ${index}`));
    }

    const rendered = renderReviewTranscript(messages).text;

    expect(rendered).toContain("user: clean up the repo");
    expect(rendered).toContain("user: yes, force pushing that branch is fine");
    expect(rendered).toContain("user: also update the changelog");
});

test("tool entries are capped by the recency limit", () => {
    const messages: ModelMessage[] = [user("do the work")];
    for (let index = 0; index < RECENT_ENTRY_LIMIT + 5; index += 1) {
        messages.push(assistantCall(`call_${index}`, `step ${index}`));
    }

    const rendered = renderReviewTranscript(messages).text;

    // The oldest tool calls drop, the newest stay, and the count is stated.
    expect(rendered).toContain('<omitted entries="5" reason="length" />');
    expect(rendered).not.toContain('"step 0"');
    expect(rendered).toContain(`"step ${RECENT_ENTRY_LIMIT + 4}"`);
});

test("an oversized entry keeps its head and its tail", () => {
    // Head-only truncation loses the end of a tool result, which is usually
    // where the outcome is, and the end of a long user turn, which is often
    // where the actual request lands.
    const long = `START${"x".repeat(MAX_MESSAGE_ENTRY_TOKENS * 4 + 400)}END`;

    const rendered = renderReviewTranscript([user(long)]).text;

    expect(rendered).toContain("[1] user: START");
    expect(rendered).toContain('<truncated omitted_approx_tokens="102" />');
    expect(rendered).toContain("END");
    expect(rendered.length).toBeLessThan(long.length);
});

test("truncation fits the marker inside the cap rather than adding to it", () => {
    const long = "x".repeat(MAX_MESSAGE_ENTRY_TOKENS * 4 + 400);

    const rendered = renderReviewTranscript([user(long)]).text;

    // The entry cap is a cap, not a target the marker is allowed to exceed.
    expect(rendered.length).toBeLessThanOrEqual(
        MAX_MESSAGE_ENTRY_TOKENS * 4 + "[1] user: ".length,
    );
});

test("entry caps are measured in utf-8 bytes, not code units", () => {
    // 3,000 CJK characters is 9,000 UTF-8 bytes, over the 4,000-byte tool
    // entry cap, but only 3,000 UTF-16 code units, which is under it. Counting
    // units would let this entry carry more than twice its budget.
    const text = "漢".repeat(3_000);
    const rendered = renderReviewTranscript([
        user("check the fixture"),
        assistantCall("call_1", "cat fixture.txt"),
        toolResult("call_1", text),
    ]).text;

    expect(rendered).toContain("<truncated omitted_approx_tokens=");
    expect(rendered).not.toContain(text);
});

test("truncation never splits a character", () => {
    // Astral characters are two UTF-16 units and four UTF-8 bytes, so a cut
    // taken at a raw offset lands mid-character and decodes to a replacement
    // character.
    const text = "\u{1f600}".repeat(3_000);
    const rendered = renderReviewTranscript([
        user("check the fixture"),
        assistantCall("call_1", "cat fixture.txt"),
        toolResult("call_1", text),
    ]).text;

    expect(rendered).toContain("<truncated omitted_approx_tokens=");
    expect(rendered).not.toContain("�");
    expect(/[\ud800-\udfff]/.test(rendered.replace(/\u{1f600}/gu, ""))).toBe(
        false,
    );
});
