import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiQuestionUpdate,
    createTuiQuestionResponse,
    createTuiQuestionView,
    QUESTION_CHOICE_MAX_WIDTH,
} from "../../clients/tui/question.ts";
import { applyTuiTheme } from "../../clients/tui/state.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("question view repaints every persistent themed surface", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    const nextTheme = {
        ...VERA_TUI_THEME,
        accent: "#123456",
        muted: "#654321",
        panel: "#112233",
    };

    try {
        view.update(request);
        applyTuiTheme(nextTheme);
        view.repaint();
        expect(view.detailsText.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.accent).toInts(),
        );
        expect(view.choiceAction.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.muted).toInts(),
        );
        expect(view.cancelAction.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.muted).toInts(),
        );
        expect(view.box.backgroundColor.toInts()).toEqual(
            RGBA.fromHex(nextTheme.panel).toInts(),
        );
    } finally {
        applyTuiTheme(VERA_TUI_THEME);
        setup.renderer.destroy();
    }
});
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

test("TUI question renders the choices as a highlighted list", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(request);

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Which release channel should Vera use?");
        const lines = frame.split("\n");
        // The question is the card's heading, so it starts on the same column
        // as the answers to it rather than being indented against them.
        const questionLine = lines.find((line) =>
            line.includes("Which release channel")
        );
        const firstChoice = lines.find((line) => line.includes("1. Stable"));
        expect(questionLine?.indexOf("Which")).toBe(firstChoice?.indexOf("1."));
        // Numbers front each choice; no bracket noise.
        expect(frame).toContain("1. Stable");
        expect(frame).toContain("2. Preview");
        expect(frame).toContain("3. Other");
        expect(frame).not.toContain("[1]");
        expect(frame).toContain("↑↓ select");
        expect(frame).toContain("esc dismiss");
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI question accepts a typed custom answer", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    view.update(request);
    try {
        expect(view.handleKey(request, { name: "3", sequence: "3" }))
            .toEqual({ handled: true });
        for (const character of "Use Arc") {
            expect(view.handleKey(request, {
                name: character,
                sequence: character,
            }).handled).toBe(true);
        }
        expect(view.handleKey(request, { name: "enter" })).toEqual({
            handled: true,
            response: {
                type: "ui_response",
                requestId: "question-1",
                response: {
                    type: "user_question",
                    outcome: "custom",
                    text: "Use Arc",
                },
            },
        });
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI question edits a custom answer at the caret", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    view.update(request);
    try {
        view.handleKey(request, { name: "3", sequence: "3" });
        for (const character of "Use Ac") {
            view.handleKey(request, { name: character, sequence: character });
        }
        view.handleKey(request, { name: "left" });
        view.handleKey(request, { name: "r", sequence: "r" });
        expect(view.handleKey(request, { name: "enter" }).response?.response)
            .toEqual({
                type: "user_question",
                outcome: "custom",
                text: "Use Arc",
            });
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI question pastes into the active custom field", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    view.update(request);
    try {
        view.handleKey(request, { name: "3", sequence: "3" });
        expect(view.handlePaste("Use Arc\n")).toBe(true);
        expect(view.handleKey(request, { name: "enter" }).response?.response)
            .toEqual({
                type: "user_question",
                outcome: "custom",
                text: "Use Arc",
            });
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI question arrow keys select without touching the engine early", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    view.update(request);

    try {
        // Arrows are handled locally and produce no response.
        expect(view.handleKey(request, { name: "down" }))
            .toEqual({ handled: true });
        // Enter now resolves to the highlighted (second) choice.
        expect(view.handleKey(request, { name: "return" })).toEqual({
            handled: true,
            response: {
                type: "ui_response",
                requestId: "question-1",
                response: {
                    type: "user_question",
                    outcome: "selected",
                    choiceId: "preview-channel",
                },
            },
        });
        // Clamped at the top; still no response.
        expect(view.handleKey(request, { name: "up" }))
            .toEqual({ handled: true });
        // The choice list does not use left or right, and neither leaks.
        expect(view.handleKey(request, { name: "left" }))
            .toEqual({ handled: true });
        expect(view.handleKey(request, { name: "right" }))
            .toEqual({ handled: true });
        // A digit still selects immediately regardless of the highlight.
        expect(view.handleKey(request, { name: "1", sequence: "1" }).response)
            .toEqual({
                type: "ui_response",
                requestId: "question-1",
                response: {
                    type: "user_question",
                    outcome: "selected",
                    choiceId: "stable-channel",
                },
            });
        // Escape cancels through the same handler.
        expect(view.handleKey(request, { name: "escape" }).response?.response)
            .toEqual({ type: "user_question", outcome: "cancelled" });
    } finally {
        setup.renderer.destroy();
    }
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
                expect(frame).toContain("Which release channel");
        expect(frame).toContain("↑↓ select");
        expect(frame).toContain("esc dismiss");
        expect(view.box.width).toBe(80);
        expect(view.box.left).toBe(0);
        expect(view.bar.height).toBe(view.box.height);
        // The accent edge runs the whole height of the card, so the last row
        // carries it and nothing else.
        expect(frame.split("\n")[view.box.screenY + view.box.height - 1])
            .toBe(`┃${" ".repeat(79)}`);
        expect(setup.renderer.currentFocusedRenderable).toBe(view.details);
        expect(view.box.zIndex).toBe(20);
        expect(view.actions.screenY).toBeLessThan(18);

        setup.resize(42, 10);
        // Geometry is re-read on update, so the resize goes through one.
        view.update(longRequest("long-question"));
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(view.box.bottom).toBe(0);
        expect(view.box.width).toBe(42);
        expect(view.box.left).toBe(0);
        // The title is clipped here, not by the offset but by the existing
        // `maxHeight: "100%"` short-terminal rule, which lets the box start one
        // row above the viewport. The question itself, its choices, and its key
        // hints all survive, which is the order that matters.
        expect(frame).toContain("Which release channel");
        expect(frame).toContain("↑↓ select");
        expect(frame).toContain("esc dismiss");
        expect(view.actions.screenY).toBeLessThan(10);
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(10);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);

        const actionsY = view.actions.screenY;
        setup.mockInput.pressKey("\x1b[6~");
        await setup.flush();
        expect(view.details.scrollTop).toBeGreaterThan(0);
        expect(view.actions.screenY).toBe(actionsY);
        expect(setup.captureCharFrame()).toContain("esc dismiss");

        setup.resize(24, 6);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("↑↓ select");
        expect(frame).toContain("esc dismiss");
        expect(view.actions.screenY + view.actions.height).toBeLessThanOrEqual(6);
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
        // The card ends on the terminal's last row, with no gutter under it.
        expect(view.box.screenY + shortHeight).toBe(18);
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
        expect(view.box.screenY + view.box.height).toBe(18);
        expect(view.details.scrollHeight).toBeGreaterThan(view.details.height);
        expect(setup.captureCharFrame()).toContain("↑↓ select");
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

const previewRequest: UserQuestionUiRequestUpdate = {
    ...request,
    requestId: "question-preview",
    request: {
        ...request.request,
        choices: [
            {
                id: "stable-channel",
                label: "Stable",
                preview: "┌────────┐\n│ stable │\n└────────┘",
            },
            {
                id: "preview-channel",
                label: "Preview",
                preview: "┌─────────┐\n│ preview │\n└─────────┘",
            },
        ],
    },
};

test("TUI question shows the highlighted choice's preview beside it", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(previewRequest);

    try {
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("│ stable │");
        expect(frame).not.toContain("│ preview │");
        // Side by side, but centered rather than pinned to the pane's top.
        const lines = frame.split("\n");
        const stableLine = frame.split("\n")
            .find((line) => line.includes("1. Stable"));
        const diagramLine = lines.find((line) => line.includes("│ stable │"));
        expect(lines.indexOf(diagramLine!)).toBeGreaterThan(
            lines.indexOf(stableLine!),
        );
        expect(diagramLine?.indexOf("│ stable │")).toBeGreaterThan(60);

        view.handleKey(previewRequest, { name: "down" });
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("│ preview │");
        expect(frame).not.toContain("│ stable │");
    } finally {
        setup.renderer.destroy();
    }
});

test("a narrow terminal puts the preview under the choices", async () => {
    const setup = await createTestRenderer({ width: 60, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(previewRequest);

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("│ stable │");
        const stableLine = frame.split("\n")
            .find((line) => line.includes("1. Stable"));
        expect(stableLine).not.toContain("│ stable │");
    } finally {
        setup.renderer.destroy();
    }
});

test("a centered preview reserves every row of a taller diagram", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({
        ...previewRequest,
        requestId: "question-tall-preview",
        request: {
            ...previewRequest.request,
            choices: [
                {
                    id: "table",
                    label: "Table layout",
                    preview: "┌─────┬─────┐\n│ Col1│ Col2│\n├─────┼─────┤\n│ A   │ B   │\n└─────┴─────┘",
                },
                { id: "plain", label: "Plain" },
            ],
        },
    });

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("┌─────┬─────┐");
        expect(frame).toContain("│ Col1│ Col2│");
        expect(frame).toContain("├─────┼─────┤");
        expect(frame).toContain("│ A   │ B   │");
        expect(frame).toContain("└─────┴─────┘");
    } finally {
        setup.renderer.destroy();
    }
});

test("a short text preview is not rendered", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({
        ...previewRequest,
        requestId: "question-text-preview",
        request: {
            ...previewRequest.request,
            choices: [
                {
                    id: "inspect",
                    label: "Yes, inspect them",
                    description: "Read the relevant files first.",
                    preview: "Ask permission → inspect files → report finding",
                },
                { id: "wait", label: "No, don't inspect yet" },
            ],
        },
    });

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("1. Yes, inspect them");
        expect(frame).not.toContain(
            "Ask permission → inspect files → report finding",
        );
    } finally {
        setup.renderer.destroy();
    }
});

test("a fenced one-line preview is not rendered", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({
        ...previewRequest,
        requestId: "question-fenced-text-preview",
        request: {
            ...previewRequest.request,
            choices: [
                {
                    id: "write",
                    label: "Write or modify code",
                    preview: "```text\nWrite or modify code\n```",
                },
                { id: "review", label: "Review existing code" },
            ],
        },
    });

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("```");
        expect(frame.match(/Write or modify code/g)?.length).toBe(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("longer and tilde fences cannot turn one line into a visual preview", async () => {
    for (const preview of [
        "````text\nWrite or modify code\n````",
        "~~~text\nWrite or modify code\n~~~",
    ]) {
        const setup = await createTestRenderer({ width: 100, height: 24 });
        const view = createTuiQuestionView(setup.renderer);
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update({
            ...previewRequest,
            requestId: `question-fenced-${preview[0]}`,
            request: {
                ...previewRequest.request,
                choices: [
                    { id: "write", label: "Write", preview },
                    { id: "review", label: "Review" },
                ],
            },
        });

        try {
            await setup.flush();
            expect(setup.captureCharFrame()).not.toContain("Write or modify code");
        } finally {
            setup.renderer.destroy();
        }
    }
});

test("notes typed alongside a choice travel with the answer", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(previewRequest);

    try {
        expect(view.handleKey(previewRequest, { name: "tab" }))
            .toEqual({ handled: true });
        for (const character of "but pin it") {
            view.handleKey(previewRequest, {
                name: character,
                sequence: character,
            });
        }
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Notes: but pin it");
        expect(view.handleKey(previewRequest, { name: "enter" })).toEqual({
            handled: true,
            response: {
                type: "ui_response",
                requestId: "question-preview",
                response: {
                    type: "user_question",
                    outcome: "selected",
                    choiceId: "stable-channel",
                    notes: "but pin it",
                },
            },
        });
    } finally {
        setup.renderer.destroy();
    }
});

test("question notes support caret movement and forward delete", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    view.update(previewRequest);
    try {
        view.handleKey(previewRequest, { name: "tab" });
        for (const character of "pin itt") {
            view.handleKey(previewRequest, {
                name: character,
                sequence: character,
            });
        }
        view.handleKey(previewRequest, { name: "left" });
        view.handleKey(previewRequest, { name: "delete" });
        expect(view.handleKey(previewRequest, { name: "enter" })
            .response?.response).toEqual({
                type: "user_question",
                outcome: "selected",
                choiceId: "stable-channel",
                notes: "pin it",
            });
    } finally {
        setup.renderer.destroy();
    }
});

test("escape leaves the notes field without cancelling the question", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    view.update(previewRequest);
    try {
        view.handleKey(previewRequest, { name: "tab" });
        expect(view.handleKey(previewRequest, { name: "escape" }))
            .toEqual({ handled: true });
        expect(view.handleKey(previewRequest, { name: "1", sequence: "1" }))
            .toEqual({
                handled: true,
                response: {
                    type: "ui_response",
                    requestId: "question-preview",
                    response: {
                        type: "user_question",
                        outcome: "selected",
                        choiceId: "stable-channel",
                    },
                },
            });
    } finally {
        setup.renderer.destroy();
    }
});

const wideRequest: UserQuestionUiRequestUpdate = {
    type: "ui_request",
    requestId: "question-wide",
    request: {
        type: "user_question",
        question: "Which approach should we take?",
        choices: [
            {
                id: "conservative",
                label: "Stable, which is the conservative option that most"
                    + " people should pick unless they have a reason not to",
            },
            { id: "preview-channel", label: "Preview" },
        ],
    },
    seq: 1,
};

test("a choice description sits under its label, not beside it", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({
        ...request,
        requestId: "described",
        request: {
            ...request.request,
            choices: [
                {
                    id: "stable-channel",
                    label: "Stable",
                    description: "Ships when it is ready.",
                },
                { id: "preview-channel", label: "Preview" },
            ],
        },
    });

    try {
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const labelLine = lines.findIndex((line) => line.includes("1. Stable"));
        const detailLine = lines.findIndex((line) =>
            line.includes("Ships when it is ready.")
        );
        expect(labelLine).toBeGreaterThanOrEqual(0);
        expect(detailLine).toBe(labelLine + 1);
        // Indented past the number column, so the numbers read as a column.
        expect(lines[detailLine]?.indexOf("Ships"))
            .toBe(lines[labelLine]!.indexOf("1.") + 3);
        // A choice without one gets no blank line standing in for it.
        expect(lines[detailLine + 1]).toContain("2. Preview");
    } finally {
        setup.renderer.destroy();
    }
});

test("a recommended choice is listed first, highlighted, and hinted", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const recommendedRequest: UserQuestionUiRequestUpdate = {
        ...request,
        requestId: "recommended",
        request: {
            ...request.request,
            choices: [
                { id: "stable-channel", label: "Stable" },
                {
                    id: "preview-channel",
                    label: "Preview",
                    recommended: true,
                },
            ],
        },
    };
    view.update(recommendedRequest);

    try {
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const previewLine = lines.findIndex((line) => line.includes("1. Preview"));
        const hintLine = lines.findIndex((line) =>
            line.includes("recommended") && !line.includes("1.")
        );
        const stableLine = lines.findIndex((line) => line.includes("2. Stable"));
        expect(previewLine).toBeGreaterThanOrEqual(0);
        expect(hintLine).toBe(previewLine + 1);
        expect(stableLine).toBe(hintLine + 1);
        expect(lines[previewLine]?.includes("recommended")).toBe(false);
        expect(createTuiQuestionResponse(recommendedRequest, {
            name: "1",
            sequence: "1",
        })?.response).toEqual({
            type: "user_question",
            outcome: "selected",
            choiceId: "preview-channel",
        });
        expect(view.handleKey(recommendedRequest, { name: "return" })).toEqual({
            handled: true,
            response: {
                type: "ui_response",
                requestId: "recommended",
                response: {
                    type: "user_question",
                    outcome: "selected",
                    choiceId: "preview-channel",
                },
            },
        });
    } finally {
        setup.renderer.destroy();
    }
});

test("a wide terminal stops choice text from running the full width", async () => {
    const setup = await createTestRenderer({ width: 220, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(wideRequest);

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        const choiceLine = frame.split("\n")
            .find((line) => line.includes("1. Stable, which is"));
        expect(choiceLine).toBeDefined();
        // The row is the card indent plus the capped column. Uncapped, this
        // same choice runs past 110 cells on a terminal this wide.
        expect(choiceLine?.trimEnd().length)
            .toBeLessThanOrEqual(QUESTION_CHOICE_MAX_WIDTH + 8);
        expect(frame).toContain("unless they have a");
    } finally {
        setup.renderer.destroy();
    }
});

test("entering a custom answer labels the row as the response", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiQuestionView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(request);

    try {
        await setup.flush();
        expect(setup.captureCharFrame())
            .toContain("3. Other");

        view.handleKey(request, { name: "3", sequence: "3" });
        for (const character of "Arc") {
            view.handleKey(request, { name: character, sequence: character });
        }
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("3. Other: Arc");
    } finally {
        setup.renderer.destroy();
    }
});

test("fixed choices have no Other answer and cannot select one by number or arrows", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    const fixed: UserQuestionUiRequestUpdate = {
        ...request, request: { ...request.request, allowCustom: false,
            question: "Continue?", choices: [{ id: "no", label: "No, stop" }, { id: "yes", label: "Yes, once" }] },
    };
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(fixed);
    try {
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("No, stop");
        expect(frame).toContain("Yes, once");
        expect(frame).not.toContain("Other");
        expect(view.handleKey(fixed, { name: "3" }).response).toBeUndefined();
        expect(view.handleKey(fixed, { name: "return" }).response?.response).toMatchObject({ outcome: "selected", choiceId: "no" });
        view.handleKey(fixed, { name: "down" });
        view.handleKey(fixed, { name: "down" });
        expect(view.handleKey(fixed, { name: "return" }).response?.response).toMatchObject({ outcome: "selected", choiceId: "yes" });
        expect(view.handleKey(fixed, { name: "escape" }).response?.response).toMatchObject({ outcome: "cancelled" });
    } finally {
        setup.renderer.destroy();
    }
});


test("a named custom action has a blank four-character input beside its label", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiQuestionView(setup.renderer);
    const named: UserQuestionUiRequestUpdate = {
        ...request, request: { ...request.request, customLabel: "Increase budget and continue", allowNotes: false,
            question: "Continue?", choices: [{ id: "stop", label: "Stop" }, { id: "ignore", label: "Ignore budget and continue" }] },
    };
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(named);
    try {
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("3. Increase budget and continue");
        expect(setup.captureCharFrame()).not.toContain("Other");
        view.handleKey(named, { name: "down" });
        view.handleKey(named, { name: "down" });
        expect(view.handleKey(named, { name: "tab" }).handled).toBe(true);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("Notes:");
        expect(setup.captureCharFrame()).not.toContain("tab notes");
        expect(setup.captureCharFrame()).not.toContain("Optional context");
        view.handleKey(named, { name: "return" });
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("Type");
        for (const character of "2.50") view.handleKey(named, { name: character, sequence: character });
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const label = lines.findIndex((line) => line.includes("Increase budget and continue"));
        const amount = lines.findIndex((line) => line.includes("2.50"));
        expect(amount).toBe(label);
        expect(lines[label]).toContain("Increase budget and continue: 2.50");
        expect(view.handleKey(named, { name: "return" }).response?.response).toEqual({
            type: "user_question", outcome: "custom", text: "2.50",
        });
    } finally {
        setup.renderer.destroy();
    }
});
