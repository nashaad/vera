import { describe, expect, test } from "bun:test";

import {
    requestKeyAction,
    requestKeyResponse,
    requestKeysAllowed,
    type FocusedElement,
} from "../../clients/ui/src/session/requestKeys.ts";
import type { ApprovalRequest, QuestionRequest, SetupRequest } from "../../clients/ui/src/session/requests.ts";

const NO_MODIFIERS = { ctrlKey: false, metaKey: false, altKey: false };

const fullApproval: ApprovalRequest = {
    kind: "approval",
    requestId: "r1",
    tool: "bash",
    input: { command: "git status" },
    reason: "",
    warning: "",
    grants: ["bash"],
    grantPredicates: [{ tool: "bash" }],
};

const subagentApproval: ApprovalRequest = {
    ...fullApproval,
    requestId: "r2",
    sourceAgentId: "child-1234567890",
};

const question: QuestionRequest = {
    kind: "question",
    requestId: "q1",
    question: "Which branch?",
    choices: [
        { id: "a", label: "main", recommended: true },
        { id: "b", label: "dev", recommended: false },
    ],
    allowCustom: false,
    allowNotes: true,
    outOfBand: false,
};

const setup: SetupRequest = { kind: "setup", requestId: "s1", reason: "Pick a model.", waiting: 1 };

function focus(overrides: Partial<FocusedElement>): FocusedElement {
    return { tagName: "BUTTON", isContentEditable: false, classes: [], empty: false, ...overrides };
}

describe("approval keys", () => {
    const ask = { mode: "ask", modes: ["readonly", "ask", "auto"] };

    test("the digits answer the rows in order and Escape denies", () => {
        expect(requestKeyAction(fullApproval, "1")).toEqual({ type: "decide", decision: "allow_similar" });
        expect(requestKeyAction(fullApproval, "2")).toEqual({ type: "decide", decision: "allow_always" });
        expect(requestKeyAction(fullApproval, "3")).toEqual({ type: "decide", decision: "deny" });
        expect(requestKeyAction(fullApproval, "Escape")).toEqual({ type: "decide", decision: "deny" });
    });

    test("in ask the third answer runs the call and switches to auto", () => {
        expect(requestKeyAction(fullApproval, "3", ask)).toEqual({
            type: "decide",
            decision: "allow_once",
            switchToAuto: true,
        });
        expect(requestKeyAction(fullApproval, "4", ask)).toEqual({ type: "decide", decision: "deny" });
    });

    test("a subagent approval offers this time and no only", () => {
        expect(requestKeyAction(subagentApproval, "1")).toEqual({ type: "decide", decision: "allow_once" });
        expect(requestKeyAction(subagentApproval, "2")).toEqual({ type: "decide", decision: "deny" });
        expect(requestKeyAction(subagentApproval, "3", ask)).toBeUndefined();
        expect(requestKeyAction(subagentApproval, "Escape")).toEqual({ type: "decide", decision: "deny" });
    });

    test("an approval with no grants offers this time, the switch, and no", () => {
        const bare: ApprovalRequest = { ...fullApproval, grants: [], grantPredicates: [] };
        expect(requestKeyAction(bare, "1")).toEqual({ type: "decide", decision: "allow_once" });
        expect(requestKeyAction(bare, "2", ask)).toEqual({ type: "decide", decision: "allow_once", switchToAuto: true });
        expect(requestKeyAction(bare, "3", ask)).toEqual({ type: "decide", decision: "deny" });
    });

    test("a restricted approval has no grant answers and no switch", () => {
        const restricted: ApprovalRequest = { ...fullApproval, restrictedChoices: true };
        expect(requestKeyAction(restricted, "1", ask)).toEqual({ type: "decide", decision: "allow_once" });
        expect(requestKeyAction(restricted, "2", ask)).toEqual({ type: "decide", decision: "deny" });
        expect(requestKeyAction(restricted, "3", ask)).toBeUndefined();
    });

    test("other keys do nothing", () => {
        expect(requestKeyAction(fullApproval, "5", ask)).toBeUndefined();
        expect(requestKeyAction(fullApproval, "a")).toBeUndefined();
        expect(requestKeyAction(fullApproval, "Enter")).toBeUndefined();
    });

    test("the approval response is a tool_approval line", () => {
        const action = requestKeyAction(fullApproval, "1");
        if (action === undefined) throw new Error("expected an action");
        expect(JSON.parse(requestKeyResponse(fullApproval, action, "") ?? "")).toEqual({
            type: "ui_response",
            requestId: "r1",
            response: { type: "tool_approval", decision: "allow_similar" },
        });
    });
});

describe("question keys", () => {
    test("digits in range pick that choice", () => {
        expect(requestKeyAction(question, "1")).toEqual({ type: "choose", index: 0 });
        expect(requestKeyAction(question, "2")).toEqual({ type: "choose", index: 1 });
    });

    test("digits out of range do nothing", () => {
        expect(requestKeyAction(question, "3")).toBeUndefined();
        expect(requestKeyAction(question, "9")).toBeUndefined();
        expect(requestKeyAction(question, "0")).toBeUndefined();
    });

    test("Escape cancels", () => {
        expect(requestKeyAction(question, "Escape")).toEqual({ type: "cancel" });
    });

    test("a choice answer carries the notes only when notes are allowed", () => {
        const action = requestKeyAction(question, "1");
        if (action === undefined) throw new Error("expected an action");
        expect(JSON.parse(requestKeyResponse(question, action, " quick ") ?? "").response).toEqual({
            type: "user_question",
            outcome: "selected",
            choiceId: "a",
            notes: "quick",
        });
        const noNotes: QuestionRequest = { ...question, allowNotes: false };
        expect(JSON.parse(requestKeyResponse(noNotes, action, " quick ") ?? "").response).toEqual({
            type: "user_question",
            outcome: "selected",
            choiceId: "a",
        });
    });

    test("cancel answers with the cancelled outcome", () => {
        const action = requestKeyAction(question, "Escape");
        if (action === undefined) throw new Error("expected an action");
        expect(JSON.parse(requestKeyResponse(question, action, "") ?? "").response).toEqual({
            type: "user_question",
            outcome: "cancelled",
        });
    });
});

describe("setup keys", () => {
    test("Escape dismisses as unavailable and other keys do nothing", () => {
        expect(requestKeyAction(setup, "Escape")).toEqual({ type: "dismiss" });
        expect(requestKeyAction(setup, "1")).toBeUndefined();
        const action = requestKeyAction(setup, "Escape");
        if (action === undefined) throw new Error("expected an action");
        expect(JSON.parse(requestKeyResponse(setup, action, "") ?? "").response).toEqual({
            type: "configuration_required",
            outcome: "unavailable",
        });
    });
});

describe("an action answers only its own kind of request", () => {
    test("a decision never answers a question or a setup", () => {
        const action = { type: "decide", decision: "deny" } as const;
        expect(requestKeyResponse(question, action, "")).toBeUndefined();
        expect(requestKeyResponse(setup, action, "")).toBeUndefined();
    });
});

describe("focus and modifiers", () => {
    test("keys are read with nothing focused or on a button", () => {
        expect(requestKeysAllowed(NO_MODIFIERS, null)).toBe(true);
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "BUTTON" }))).toBe(true);
    });

    test("a held ctrl, meta or alt key stops every request key", () => {
        expect(requestKeysAllowed({ ...NO_MODIFIERS, ctrlKey: true }, null)).toBe(false);
        expect(requestKeysAllowed({ ...NO_MODIFIERS, metaKey: true }, null)).toBe(false);
        expect(requestKeysAllowed({ ...NO_MODIFIERS, altKey: true }, null)).toBe(false);
    });

    test("inputs, selects and rich text fields keep their keys", () => {
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "INPUT" }))).toBe(false);
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "SELECT" }))).toBe(false);
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "DIV", isContentEditable: true }))).toBe(false);
    });

    test("digits and Escape typed in the approval's answer box do not answer the card", () => {
        const box = focus({ tagName: "INPUT", classes: ["request-input"] });
        expect(requestKeysAllowed(NO_MODIFIERS, box)).toBe(false);
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "INPUT", classes: ["request-input"], empty: true }))).toBe(false);
    });

    test("a textarea keeps its keys unless it is an empty composer", () => {
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "TEXTAREA", classes: ["composer-input"], empty: true }))).toBe(true);
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "TEXTAREA", classes: ["composer-input"], empty: false }))).toBe(false);
        expect(requestKeysAllowed(NO_MODIFIERS, focus({ tagName: "TEXTAREA", classes: ["request-textarea"], empty: true }))).toBe(false);
    });
});
