import { expect, test } from "bun:test";

import {
    createStdioQuestionResponse,
    renderStdioQuestion,
} from "../../clients/stdio/question.ts";
import type { UserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";

const request: UserQuestionUiRequestUpdate = {
    type: "ui_request",
    requestId: "question-1",
    request: {
        type: "user_question",
        question: "Which release channel should Vera use?",
        choices: [
            { id: "stable-channel", label: "Stable" },
            { id: "preview-channel", label: "Preview" },
        ],
    },
    seq: 1,
};

test("stdio question renders numbered choices and returns stable IDs", () => {
    expect(renderStdioQuestion(request)).toBe([
        "Which release channel should Vera use?",
        "1. Stable",
        "2. Preview",
        "3. Other (type your answer)",
    ].join("\n"));
    expect(createStdioQuestionResponse(request, "2")).toEqual({
        type: "ui_response",
        requestId: "question-1",
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "preview-channel",
        },
    });
    expect(createStdioQuestionResponse(request, "3")).toBeUndefined();
    expect(createStdioQuestionResponse(request, "use nightly instead")).toEqual({
        type: "ui_response",
        requestId: "question-1",
        response: {
            type: "user_question",
            outcome: "custom",
            text: "use nightly instead",
        },
    });
});

test("stdio question cancels on c, cancel, or input end", () => {
    const cancelled = {
        type: "ui_response" as const,
        requestId: "question-1",
        response: {
            type: "user_question" as const,
            outcome: "cancelled" as const,
        },
    };
    expect(createStdioQuestionResponse(request, "c")).toEqual(cancelled);
    expect(createStdioQuestionResponse(request, "cancel")).toEqual(cancelled);
    expect(createStdioQuestionResponse(request, undefined)).toEqual(cancelled);
});
