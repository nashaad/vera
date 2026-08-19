import { expect, test } from "bun:test";

import {
    attentionNotice,
    attentionNoticeSequence,
    newAttentionRows,
    parseTerminalFocusEvent,
} from "../../clients/tui/attention-notice.ts";
import {
    buildWorkIndex,
    type WorkAgentFacts,
} from "../../src/host/work-index.ts";

const now = () => Date.parse("2026-08-14T12:00:00.000Z");

function agent(overrides: Partial<WorkAgentFacts>): WorkAgentFacts {
    return {
        id: "agent",
        session_path: "/sessions/agent.jsonl",
        title: "agent",
        workspace: "/w",
        kind: "interactive",
        status: "idle",
        live: true,
        updated_at: "2026-08-14T11:59:00.000Z",
        ...overrides,
    };
}

function approval(id: string) {
    return agent({
        id,
        title: id,
        status: "waiting",
        pending_request: {
            type: "tool_approval",
            toolCall: { id: "call", name: "bash", input: { command: "ls" } },
            reason: "",
            warning: "",
        },
    });
}

function question(id: string) {
    return agent({
        id,
        title: id,
        status: "waiting",
        pending_request: {
            type: "user_question",
            question: "Which one?",
            choices: [],
        },
    });
}

test("a focus change is read out of the raw chunk that carried it", () => {
    expect(parseTerminalFocusEvent("\u001b[I")).toBe("focus_in");
    expect(parseTerminalFocusEvent("\u001b[O")).toBe("focus_out");
    // Terminals coalesce a focus change with whatever was typed around it.
    expect(parseTerminalFocusEvent("\u001b[Oabc")).toBe("focus_out");
    expect(parseTerminalFocusEvent("abc\u001b[I")).toBe("focus_in");
    // The last one wins: away and back inside one chunk is back.
    expect(parseTerminalFocusEvent("\u001b[O\u001b[I")).toBe("focus_in");
    expect(parseTerminalFocusEvent("plain typing")).toBeUndefined();
    expect(parseTerminalFocusEvent("")).toBeUndefined();
});

test("a pasted transcript is never read as a focus change", () => {
    expect(parseTerminalFocusEvent("\u001b[200~ \u001b[O \u001b[201~"))
        .toBeUndefined();
});

test("only rows that newly need an answer are announced", () => {
    const before = buildWorkIndex([approval("one")], [], { now });
    const after = buildWorkIndex([approval("one"), question("two")], [], { now });

    expect(newAttentionRows(before, after).map((row) => row.id))
        .toEqual(["two"]);
    expect(newAttentionRows(after, after)).toEqual([]);
});

test("the first index announces everything already waiting", () => {
    const index = buildWorkIndex([approval("one")], [], { now });

    expect(newAttentionRows(undefined, index).map((row) => row.id))
        .toEqual(["one"]);
});

test("one row answered as another arrives is still announced", () => {
    const before = buildWorkIndex([approval("one")], [], { now });
    const after = buildWorkIndex([approval("two")], [], { now });

    expect(newAttentionRows(before, after).map((row) => row.id))
        .toEqual(["two"]);
});

test("work that is merely running is never announced", () => {
    const before = buildWorkIndex([], [], { now });
    const after = buildWorkIndex(
        [agent({ id: "busy", status: "working" })],
        [],
        { now },
    );

    expect(newAttentionRows(before, after)).toEqual([]);
});

test("a finished background result is announced too", () => {
    const after = buildWorkIndex([agent({
        id: "digest",
        title: "digest",
        kind: "background",
        status: "completed",
        unread_result: true,
    })], [], { now });

    expect(attentionNotice(newAttentionRows(undefined, after), false)?.text)
        .toBe("digest finished");
});

test("a notice states the session and the reason", () => {
    const rows = buildWorkIndex([approval("auth-race")], [], { now }).rows;

    expect(attentionNotice(rows, false)?.text).toBe("auth-race needs approval");
    expect(attentionNotice(
        buildWorkIndex([question("browser-tests")], [], { now }).rows,
        false,
    )?.text).toBe("browser-tests has a question");
});

test("several rows at once are one notice, not several", () => {
    const rows = buildWorkIndex(
        [approval("one"), question("two"), approval("three")],
        [],
        { now },
    ).rows;

    const notice = attentionNotice(rows, false);
    expect(notice?.text).toBe("3 sessions need you");
    expect(notice?.rowIds).toHaveLength(3);
});

test("a focused terminal is never notified", () => {
    const rows = buildWorkIndex([approval("one")], [], { now }).rows;

    expect(attentionNotice(rows, true)).toBeUndefined();
    expect(attentionNotice([], false)).toBeUndefined();
});

test("the sequence carries the words and rings the bell", () => {
    const sequence = attentionNoticeSequence({
        text: "auth-race needs approval",
        rowIds: ["auth-race"],
    });

    expect(sequence).toBe(
        "\u001b]9;auth-race needs approval\u001b\\\u0007",
    );
});

test("a title carrying a terminator cannot end the sequence early", () => {
    const sequence = attentionNoticeSequence({
        text: "one\u001b\\ two\u0007",
        rowIds: ["one"],
    });

    expect(sequence).toBe("\u001b]9;one \\ two \u001b\\\u0007");
});
