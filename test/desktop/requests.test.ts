import { describe, expect, test } from "bun:test";

import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import {
    approvalChoices,
    approvalResponse,
    questionResponse,
    setupResponse,
    type ApprovalRequest,
} from "../../clients/ui/src/session/requests.ts";
import { parseSessionLine, type SessionMessage } from "../../clients/ui/src/session/wire.ts";

function line(value: unknown): SessionMessage {
    const message = parseSessionLine(JSON.stringify(value));
    if (message === undefined) throw new Error("test line did not parse");
    return message;
}

const approval = {
    type: "ui_request",
    requestId: "r1",
    seq: 5,
    request: {
        type: "tool_approval",
        toolCall: { id: "c1", name: "bash", input: { command: "rm -rf build" } },
        reason: "Shell commands need approval.",
        warning: "",
        permissionGrants: [{ kind: "tool", when: { tool: "bash" }, scope: "session", lifetime: "session" }],
    },
};

const question = {
    type: "ui_request",
    requestId: "q1",
    seq: 6,
    request: {
        type: "user_question",
        question: "Which branch?",
        choices: [
            { id: "a", label: "main", recommended: true },
            { id: "b", label: "dev", description: "the work branch" },
            { label: "no id" },
        ],
        allowCustom: true,
        customLabel: "Other branch",
    },
};

describe("open requests", () => {
    test("an approval parses with its tool, input and grants", () => {
        const message = line(approval);
        if (message.type !== "ui_request") throw new Error("expected a request");
        expect(message.request).toEqual({
            kind: "approval",
            requestId: "r1",
            tool: "bash",
            input: { command: "rm -rf build" },
            reason: "Shell commands need approval.",
            warning: "",
            grants: ["bash"],
        });
    });

    test("a question keeps only choices with an id and a label", () => {
        const message = line(question);
        if (message.type !== "ui_request" || message.request.kind !== "question") throw new Error("expected a question");
        expect(message.request.choices.map((choice) => choice.id)).toEqual(["a", "b"]);
        expect(message.request.choices[0]?.recommended).toBe(true);
        expect(message.request.allowCustom).toBe(true);
        expect(message.request.customLabel).toBe("Other branch");
        expect(message.request.outOfBand).toBe(false);
    });

    test("a configuration request parses with its waiting count", () => {
        const message = line({
            type: "ui_request",
            requestId: "s1",
            request: { type: "configuration_required", destination: {}, reason: "Pick a subagent model.", pendingAction: { id: "x", kind: "subagent_launch", count: 2 } },
        });
        if (message.type !== "ui_request") throw new Error("expected a request");
        expect(message.request).toEqual({ kind: "setup", requestId: "s1", reason: "Pick a subagent model.", waiting: 2 });
    });

    test("unknown request types and malformed requests are skipped", () => {
        expect(parseSessionLine(JSON.stringify({ type: "ui_request", requestId: "x", request: { type: "other" } }))).toBeUndefined();
        expect(parseSessionLine(JSON.stringify({ type: "ui_request", request: approval.request }))).toBeUndefined();
    });

    test("requests open and close on the watch", () => {
        let watch = reduceWatch(initialWatch("a"), line(approval));
        watch = reduceWatch(watch, line(question));
        expect(watch.requests.map((request) => request.requestId)).toEqual(["r1", "q1"]);
        watch = reduceWatch(watch, line({ type: "ui_request_closed", requestId: "r1", seq: 7 }));
        expect(watch.requests.map((request) => request.requestId)).toEqual(["q1"]);
    });

    test("a repeated request replaces the earlier copy", () => {
        let watch = reduceWatch(initialWatch("a"), line(approval));
        watch = reduceWatch(watch, line(approval));
        expect(watch.requests).toHaveLength(1);
    });

    test("a finished turn and an idle history clear open requests", () => {
        const open = reduceWatch(initialWatch("a"), line(approval));
        expect(reduceWatch(open, line({ type: "turn_finished" })).requests).toEqual([]);
        expect(reduceWatch(open, line({ type: "history", entries: [], status: "idle" })).requests).toEqual([]);
        expect(reduceWatch(open, line({ type: "history", entries: [], status: "waiting" })).requests).toHaveLength(1);
    });
});

describe("answers", () => {
    test("a subagent approval or one without grants offers only once and deny", () => {
        const base: ApprovalRequest = {
            kind: "approval", requestId: "r", tool: "bash", input: {}, reason: "", warning: "", grants: ["bash"],
        };
        expect(approvalChoices(base)).toEqual(["allow_once", "allow_similar", "allow_always", "deny"]);
        expect(approvalChoices({ ...base, sourceAgentId: "child" })).toEqual(["allow_once", "deny"]);
        expect(approvalChoices({ ...base, grants: [] })).toEqual(["allow_once", "deny"]);
    });

    test("responses are ui_response lines", () => {
        expect(JSON.parse(approvalResponse("r1", "deny"))).toEqual({
            type: "ui_response", requestId: "r1", response: { type: "tool_approval", decision: "deny" },
        });
        expect(JSON.parse(setupResponse("s1", "unavailable"))).toEqual({
            type: "ui_response", requestId: "s1", response: { type: "configuration_required", outcome: "unavailable" },
        });
        expect(approvalResponse("r1", "allow_once").endsWith("\n")).toBe(true);
    });

    test("question answers trim text and drop empty notes", () => {
        expect(JSON.parse(questionResponse("q1", { outcome: "selected", choiceId: "a", notes: "  " })).response)
            .toEqual({ type: "user_question", outcome: "selected", choiceId: "a" });
        expect(JSON.parse(questionResponse("q1", { outcome: "selected", choiceId: "a", notes: " fast " })).response)
            .toEqual({ type: "user_question", outcome: "selected", choiceId: "a", notes: "fast" });
        expect(JSON.parse(questionResponse("q1", { outcome: "custom", text: " release " })).response)
            .toEqual({ type: "user_question", outcome: "custom", text: "release" });
        expect(JSON.parse(questionResponse("q1", { outcome: "cancelled" })).response)
            .toEqual({ type: "user_question", outcome: "cancelled" });
    });
});
