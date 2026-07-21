import {
    BoxRenderable,
    fg,
    type Renderable,
    type RenderContext,
    ScrollBoxRenderable,
    StyledText,
    TextRenderable,
} from "@opentui/core";

import type {
    AgentUpdate,
    UiResponseCommand,
    UserQuestionUiRequestUpdate,
} from "../../src/engine/protocol.ts";
import { isUserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";

export interface TuiQuestionKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiQuestionKeyResult {
    readonly handled: boolean;
    readonly response?: UiResponseCommand;
}

export interface TuiQuestionView {
    readonly box: BoxRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
    readonly choiceAction: TextRenderable;
    readonly cancelAction: TextRenderable;
    focus(): void;
    update(update: UserQuestionUiRequestUpdate): void;
    handleKey(
        update: UserQuestionUiRequestUpdate,
        key: TuiQuestionKey,
    ): TuiQuestionKeyResult;
}

export function createTuiQuestionView(
    renderer: RenderContext,
): TuiQuestionView {
    let currentRequestId: string | undefined;
    // Highlighted choice for arrow/Enter selection. Purely client-local: it
    // never travels to the engine, which only ever sees the chosen choiceId.
    let selectedIndex = 0;
    let choiceRows: Renderable[] = [];

    const detailsText = new TextRenderable(renderer, {
        id: "question-details-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });
    const choicesColumn = new BoxRenderable(renderer, {
        id: "question-choices",
        width: "100%",
        height: "auto",
        marginTop: 1,
        flexDirection: "column",
        flexShrink: 0,
    });
    const details = new ScrollBoxRenderable(renderer, {
        id: "question-details",
        width: "100%",
        flexGrow: 1,
        minHeight: 1,
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        contentOptions: {
            flexDirection: "column",
        },
    });
    details.add(detailsText);
    details.add(choicesColumn);

    const choiceAction = new TextRenderable(renderer, {
        id: "question-choice-action",
        content: "",
        fg: TUI_MUTED,
        width: "auto",
        height: 1,
        flexShrink: 0,
    });
    const cancelAction = new TextRenderable(renderer, {
        id: "question-cancel-action",
        content: "· esc cancel",
        fg: TUI_MUTED,
        width: "auto",
        height: 1,
        flexShrink: 0,
    });
    const actions = new BoxRenderable(renderer, {
        id: "question-actions",
        width: "100%",
        height: "auto",
        maxHeight: 2,
        flexShrink: 0,
        flexDirection: "row",
        flexWrap: "wrap",
    });
    actions.add(choiceAction);
    actions.add(cancelAction);
    const box = new BoxRenderable(renderer, {
        id: "question-box",
        title: " Question ",
        border: true,
        borderColor: TUI_ACCENT,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: 1,
        left: 0,
        width: "100%",
        height: "auto",
        // Short terminals need the final row that the normal overlay margin
        // would consume. Larger terminals retain the calmer 90% cap.
        maxHeight: renderer.height <= 10 ? "100%" : "90%",
        zIndex: 20,
        flexDirection: "column",
        gap: 0,
        paddingX: 1,
        visible: false,
    });
    box.add(details);
    box.add(actions);

    function renderChoices(update: UserQuestionUiRequestUpdate): void {
        for (const row of choiceRows) {
            row.destroy();
        }
        choiceRows = [];
        update.request.choices.forEach((choice, index) => {
            const active = index === selectedIndex;
            const row = new TextRenderable(renderer, {
                id: `question-choice-${index}`,
                content: new StyledText([
                    active ? fg(TUI_ACCENT)("› ") : fg(TUI_PANEL)("  "),
                    fg(TUI_ACCENT)(`${index + 1}  `),
                    fg(TUI_TEXT)(choice.label),
                ]),
                bg: active ? TUI_ELEMENT : TUI_PANEL,
                width: "100%",
                height: "auto",
                wrapMode: "word",
                flexShrink: 0,
            });
            choicesColumn.add(row);
            choiceRows.push(row);
        });
    }

    return {
        box,
        details,
        detailsText,
        actions,
        choiceAction,
        cancelAction,
        focus(): void {
            details.focus();
        },
        update(update): void {
            box.maxHeight = renderer.height <= 10 ? "100%" : "90%";
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            selectedIndex = 0;
            detailsText.content = update.request.question;
            choiceAction.content = questionChoiceHint(update);
            renderChoices(update);
            details.scrollTo(0);
        },
        handleKey(update, key): TuiQuestionKeyResult {
            if (hasModifier(key)) {
                return { handled: false };
            }
            const count = update.request.choices.length;
            if (key.name === "up" || key.name === "down") {
                const next = key.name === "up"
                    ? Math.max(0, selectedIndex - 1)
                    : Math.min(count - 1, selectedIndex + 1);
                if (next !== selectedIndex) {
                    selectedIndex = next;
                    renderChoices(update);
                }
                return { handled: true };
            }
            if (key.name === "return" || key.name === "enter") {
                const choice = update.request.choices[selectedIndex];
                return choice === undefined
                    ? { handled: false }
                    : { handled: true, response: selectedResponse(update, choice.id) };
            }
            const response = createTuiQuestionResponse(update, key);
            return response === undefined
                ? { handled: false }
                : { handled: true, response };
        },
    };
}

export function createTuiQuestionResponse(
    update: UserQuestionUiRequestUpdate,
    key: TuiQuestionKey,
): UiResponseCommand | undefined {
    if (hasModifier(key)) {
        return undefined;
    }
    if (key.name === "escape") {
        return {
            type: "ui_response",
            requestId: update.requestId,
            response: {
                type: "user_question",
                outcome: "cancelled",
            },
        };
    }
    const value = key.sequence?.length === 1 ? key.sequence : key.name;
    const index = Number(value) - 1;
    const choice = Number.isInteger(index)
        ? update.request.choices[index]
        : undefined;
    if (choice === undefined) {
        return undefined;
    }
    return selectedResponse(update, choice.id);
}

export function applyTuiQuestionUpdate(
    current: UserQuestionUiRequestUpdate | undefined,
    update: AgentUpdate,
): UserQuestionUiRequestUpdate | undefined {
    if (
        update.type === "ui_request"
        && isUserQuestionUiRequestUpdate(update)
    ) {
        return update;
    }
    if (
        update.type === "ui_request_closed"
        && current?.requestId === update.requestId
    ) {
        return undefined;
    }
    return current;
}

function selectedResponse(
    update: UserQuestionUiRequestUpdate,
    choiceId: string,
): UiResponseCommand {
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId,
        },
    };
}

function questionChoiceHint(update: UserQuestionUiRequestUpdate): string {
    return `↑↓ move · 1-${update.request.choices.length} or ⏎ choose `;
}

function hasModifier(key: TuiQuestionKey): boolean {
    return key.ctrl === true
        || key.meta === true
        || key.option === true
        || key.shift === true
        || key.super === true
        || key.hyper === true;
}
