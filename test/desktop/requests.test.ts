import { describe, expect, test } from "bun:test";

import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import {
    approvalAnswersFor,
    approvalResponse,
    holdsTurn,
    PAST_APPROVAL_LIMIT,
    pastApprovalView,
    questionResponse,
    rememberApproval,
    setupResponse,
    type ApprovalRequest,
    type PastApproval,
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
            grantPredicates: [{ tool: "bash" }],
        });
    });

    test("a restricted approval offers only this time and no", () => {
        const message = line({
            ...approval,
            request: { ...approval.request, restrictedChoices: true },
        });
        if (message.type !== "ui_request" || message.request.kind !== "approval") {
            throw new Error("expected an approval");
        }
        expect(message.request.restrictedChoices).toBe(true);
        expect(approvalAnswersFor(message.request).map((answer) => answer.decision))
            .toEqual(["allow_once", "deny"]);
    });

    test("an approval carries the folder facts the host sent", () => {
        const message = line({
            ...approval,
            request: { ...approval.request, workspace: "/work/project", chat: true },
        });
        if (message.type !== "ui_request" || message.request.kind !== "approval") throw new Error("expected an approval");
        expect(message.request.workspace).toBe("/work/project");
        expect(message.request.chat).toBe(true);
    });

    test("an approval without folder facts has no workspace and is not a chat", () => {
        const message = line(approval);
        if (message.type !== "ui_request" || message.request.kind !== "approval") throw new Error("expected an approval");
        expect(message.request.workspace).toBeUndefined();
        expect(message.request.chat).toBeUndefined();
        const blank = line({
            ...approval,
            request: { ...approval.request, workspace: "", chat: "yes" },
        });
        if (blank.type !== "ui_request" || blank.request.kind !== "approval") throw new Error("expected an approval");
        expect(blank.request.workspace).toBeUndefined();
        expect(blank.request.chat).toBeUndefined();
    });

    test("an approval keeps each grant's raw predicate beside its words", () => {
        const message = line({
            ...approval,
            request: {
                ...approval.request,
                permissionGrants: [
                    { kind: "path", when: { verb: "write", path: "/home/ana/hello.txt" }, scope: "session" },
                    { kind: "tool", scope: "session" },
                ],
            },
        });
        if (message.type !== "ui_request" || message.request.kind !== "approval") throw new Error("expected an approval");
        expect(message.request.grants).toEqual(["write /home/ana/hello.txt", "similar actions"]);
        expect(message.request.grantPredicates).toEqual([{ verb: "write", path: "/home/ana/hello.txt" }, {}]);
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

    test("a provider setup request retains its destination", () => {
        const message = line({ type: "ui_request", requestId: "s2", request: {
            type: "configuration_required", destination: { kind: "provider", provider: "openrouter" },
            reason: "Connect a provider.", pendingAction: { count: 1 },
        } });
        if (message.type !== "ui_request") throw new Error("expected a request");
        expect(message.request).toEqual({ kind: "setup", requestId: "s2", reason: "Connect a provider.",
            waiting: 1, destination: "provider", provider: "openrouter" });
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
    const base: ApprovalRequest = {
        kind: "approval", requestId: "r", tool: "bash", input: {}, reason: "", warning: "", grants: ["bash"], grantPredicates: [{ tool: "bash" }],
    };
    const ask = { mode: "ask", modes: ["readonly", "ask", "auto"] };

    test("the shared module orders the answers and numbers follow it", () => {
        expect(approvalAnswersFor(base).map((answer) => answer.label)).toEqual([
            "Yes, for this chat",
            "Yes, and always allow actions like this",
            "No",
        ]);
        expect(approvalAnswersFor(base, ask).map((answer) => answer.decision))
            .toEqual(["allow_similar", "allow_always", "allow_once", "deny"]);
        expect(approvalAnswersFor(base, ask)[2]).toEqual({
            decision: "allow_once",
            label: "Yes, and switch to Approve for me",
            switchToAuto: true,
        });
    });

    test("a subagent approval or one without grants drops the grant answers", () => {
        expect(approvalAnswersFor({ ...base, sourceAgentId: "child" }).map((answer) => answer.decision))
            .toEqual(["allow_once", "deny"]);
        expect(approvalAnswersFor({ ...base, grants: [], grantPredicates: [] }, ask).map((answer) => answer.decision))
            .toEqual(["allow_once", "allow_once", "deny"]);
        expect(approvalAnswersFor({ ...base, restrictedChoices: true }, ask).map((answer) => answer.decision))
            .toEqual(["allow_once", "deny"]);
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

    test("a deny can carry what the person typed, trimmed, and blank text is left out", () => {
        expect(JSON.parse(approvalResponse("r1", "deny", "  use the notes folder  "))).toEqual({
            type: "ui_response",
            requestId: "r1",
            response: { type: "tool_approval", decision: "deny", notes: "use the notes folder" },
        });
        expect(JSON.parse(approvalResponse("r1", "deny", "   ")).response).toEqual({ type: "tool_approval", decision: "deny" });
        expect(JSON.parse(approvalResponse("r1", "deny", "")).response).toEqual({ type: "tool_approval", decision: "deny" });
    });

    test("notes never travel with an allow, which the host would refuse", () => {
        for (const decision of ["allow_once", "allow_similar", "allow_always"] as const) {
            expect(JSON.parse(approvalResponse("r1", decision, "use the notes folder")).response).toEqual({ type: "tool_approval", decision });
        }
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

test("an answered approval leaves nothing for an allow, one line for a denial, and the whole card when kept", () => {
    const request = { kind: "approval", requestId: "r1", tool: "bash", input: {}, reason: "", warning: "", grants: [], grantPredicates: [] } as const;
    expect(pastApprovalView({ request, decision: "allow_once" }, false)).toBe("none");
    expect(pastApprovalView({ request, decision: "allow_always" }, false)).toBe("none");
    expect(pastApprovalView({ request, decision: "deny" }, false)).toBe("line");
    expect(pastApprovalView({ request, decision: "allow_once" }, true)).toBe("card");
    expect(pastApprovalView({ request, decision: "deny" }, true)).toBe("card");
});

test("only the newest answered approvals are kept", () => {
    let past: readonly PastApproval[] = [];
    for (let index = 0; index < PAST_APPROVAL_LIMIT + 3; index += 1) {
        const request = { kind: "approval", requestId: `r${index}`, tool: "bash", input: {}, reason: "", warning: "", grants: [], grantPredicates: [] } as const;
        past = rememberApproval(past, { request, decision: "deny" });
    }
    expect(past).toHaveLength(PAST_APPROVAL_LIMIT);
    expect(past[0]?.request.requestId).toBe("r3");
    expect(past.at(-1)?.request.requestId).toBe(`r${PAST_APPROVAL_LIMIT + 2}`);
});

test("an open approval or question holds the turn, and an out-of-band question does not", () => {
    const approvalRequest = { kind: "approval", requestId: "r1", tool: "bash", input: {}, reason: "", warning: "", grants: [], grantPredicates: [] } as const;
    const question = { kind: "question", requestId: "q1", question: "Which nest?", choices: [], allowCustom: false, allowNotes: false, outOfBand: false } as const;
    expect(holdsTurn([])).toBe(false);
    expect(holdsTurn([approvalRequest])).toBe(true);
    expect(holdsTurn([question])).toBe(true);
    expect(holdsTurn([{ ...question, outOfBand: true }])).toBe(false);
    expect(holdsTurn([{ ...question, outOfBand: true }, approvalRequest])).toBe(true);
});
