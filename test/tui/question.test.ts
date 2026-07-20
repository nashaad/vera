import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiQuestionUpdate,
    createTuiQuestionResponse,
    createTuiQuestionView,
    renderTuiQuestionDetails,
} from "../../clients/tui/question.ts";
import type {
    UserQuestionUiRequestUpdate,
} from "../../src/engine/protocol.ts";

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

test("TUI question renders numbered choices", () => {
    expect(renderTuiQuestionDetails(request)).toBe([
        "Which release channel should Vera use?",
        "",
        "[1] Stable",
        "[2] Preview",
    ].join("\n"));
});

test("TUI question maps digits to stable choice IDs without Enter", () => {
    expect(createTuiQuestionResponse(request, {
        name: "2",
        sequence: "2",
    })).toEqual({
        type: "ui_response",
        requestId: "question-1",
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "preview-channel",
        },
    });

    expect(createTuiQuestionResponse(request, { name: "y" })).toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "return" }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "0" }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "3" }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "2", ctrl: true }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "2", meta: true }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "2", option: true }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "2", shift: true }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "2", super: true }))
        .toBeUndefined();
    expect(createTuiQuestionResponse(request, { name: "2", hyper: true }))
        .toBeUndefined();
});

test("TUI question cancels immediately with unmodified Escape", () => {
    expect(createTuiQuestionResponse(request, { name: "escape" })).toEqual({
        type: "ui_response",
        requestId: "question-1",
        response: {
            type: "user_question",
            outcome: "cancelled",
        },
    });
    expect(createTuiQuestionResponse(request, {
        name: "escape",
        ctrl: true,
    })).toBeUndefined();
});

test("TUI question closes only for its matching request ID", () => {
    expect(applyTuiQuestionUpdate(undefined, request)).toBe(request);
    expect(applyTuiQuestionUpdate(request, {
        type: "ui_request_closed",
        requestId: "another-question",
        seq: 2,
    })).toBe(request);
    expect(applyTuiQuestionUpdate(request, {
        type: "ui_request_closed",
        requestId: "question-1",
        seq: 3,
    })).toBeUndefined();
});

test("TUI question pins its actions in short and narrow terminals", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(longRequest("long-question"));
    view.focus();

    try {
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Question");
        expect(frame).toContain("Which release channel");
        expect(frame).toContain("[1-9] choose · [esc] cancel");
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.box.zIndex).toBe(20);
        expect(view.actions.screenY).toBeLessThan(18);

        setup.resize(42, 10);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Question");
        expect(frame).toContain("Which release channel");
        expect(frame).toContain("[1-9] choose · [esc] cancel");
        expect(view.actions.screenY).toBeLessThan(10);
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(9);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);

        const actionsY = view.actions.screenY;
        setup.mockInput.pressKey("\x1b[6~");
        await setup.flush();
        expect(view.details.scrollTop).toBeGreaterThan(0);
        expect(view.actions.screenY).toBe(actionsY);
        expect(setup.captureCharFrame()).toContain(
            "[1-9] choose · [esc] cancel",
        );

        setup.resize(24, 6);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("[1-9] choose");
        expect(frame).toContain("[esc] cancel");
        expect(view.actions.screenY + view.actions.height).toBeLessThanOrEqual(5);
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI question grows with content before details begin scrolling", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        view.update(request);
        await setup.flush();
        const shortHeight = view.box.height;
        expect(view.box.screenY + shortHeight).toBe(17);
        expect(view.details.scrollHeight).toBe(view.details.height);

        view.update(questionWithLabel(
            "Explain the tradeoff clearly. ".repeat(5),
            "medium-question",
        ));
        await setup.flush();
        const mediumHeight = view.box.height;
        expect(mediumHeight).toBeGreaterThan(shortHeight);
        expect(view.details.scrollHeight).toBe(view.details.height);

        view.update(questionWithLabel(
            "Explain the tradeoff clearly. ".repeat(100),
            "overflow-question",
        ));
        await setup.flush();
        expect(view.box.height).toBeGreaterThan(mediumHeight);
        expect(view.box.height).toBeLessThanOrEqual(16);
        expect(view.box.screenY + view.box.height).toBe(17);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);
        expect(setup.captureCharFrame()).toContain(
            "[1-2] choose · [esc] cancel",
        );
    } finally {
        setup.renderer.destroy();
    }
});

function longRequest(requestId: string): UserQuestionUiRequestUpdate {
    return {
        ...request,
        requestId,
        request: {
            ...request.request,
            choices: Array.from({ length: 9 }, (_, index) => ({
                id: `choice-${index + 1}`,
                label: `Release channel ${index + 1}: ${
                    "long explanation ".repeat(8)
                }`,
            })),
        },
    };
}

function questionWithLabel(
    label: string,
    requestId: string,
): UserQuestionUiRequestUpdate {
    return {
        ...request,
        requestId,
        request: {
            ...request.request,
            choices: [
                { id: "first-choice", label },
                { id: "second-choice", label: "Keep the current behavior" },
            ],
        },
    };
}
