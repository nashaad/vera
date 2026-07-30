import { expect, test } from "bun:test";

import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";

const validQuestion = {
    type: "ui_request",
    requestId: "question-1",
    request: {
        type: "user_question",
        question: "How should Vera continue?",
        choices: [
            { id: "automatic", label: "Continue automatically" },
            { id: "manual", label: "Wait for me" },
        ],
    },
    seq: 3,
} as const;

test("host wire accepts a semantic user question", () => {
    expect(parseAgentUpdate(validQuestion)).toEqual(validQuestion);
});

test("host wire rejects malformed semantic user questions", () => {
    expect(parseAgentUpdate({
        ...validQuestion,
        requestId: "",
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        request: { ...validQuestion.request, question: "   " },
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        request: {
            ...validQuestion.request,
            choices: [{ id: "only", label: "Only choice" }],
        },
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        request: {
            ...validQuestion.request,
            choices: [
                { id: "same", label: "First" },
                { id: "same", label: "Second" },
            ],
        },
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        request: {
            ...validQuestion.request,
            choices: [
                { id: "first", label: "First" },
                { id: "second", label: "   " },
            ],
        },
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        layout: "bottom_sheet",
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        request: {
            ...validQuestion.request,
            shortcut: "1-9",
        },
    })).toBeUndefined();
    expect(parseAgentUpdate({
        ...validQuestion,
        request: {
            ...validQuestion.request,
            choices: [
                { ...validQuestion.request.choices[0], focused: true },
                validQuestion.request.choices[1],
            ],
        },
    })).toBeUndefined();
});

test("host wire carries a choice preview and rejects a non-string one", () => {
    const withPreview = {
        ...validQuestion,
        request: {
            ...validQuestion.request,
            choices: [
                {
                    ...validQuestion.request.choices[0],
                    preview: "  indented\n  mockup",
                },
                validQuestion.request.choices[1],
            ],
        },
    };
    expect(parseAgentUpdate(withPreview)).toEqual(withPreview);
    expect(parseAgentUpdate({
        ...validQuestion,
        request: {
            ...validQuestion.request,
            choices: [
                { ...validQuestion.request.choices[0], preview: 3 },
                validQuestion.request.choices[1],
            ],
        },
    })).toBeUndefined();
});
