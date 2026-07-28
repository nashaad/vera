import {
    BoxRenderable,
    type Renderable,
    type RenderContext,
    ScrollBoxRenderable,
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
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    DIALOG_SHORT_TERMINAL_HEIGHT,
    dialogHeaderNode,
    dialogOptionRow,
    dialogRowPointer,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

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
    // Rows are numbered, so a click carries the same digit the keyboard would
    // have sent rather than a second decision path.
    pointer?: DialogRowPointer;
    readonly box: BoxRenderable;
    readonly bar: BoxRenderable;
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
    let enteringCustom = false;
    let customText = "";
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
    const header = dialogHeaderNode(renderer, "Question");
    header.paddingLeft = 0;
    const bar = new BoxRenderable(renderer, {
        id: "question-bar",
        width: 1,
        backgroundColor: TUI_ACCENT,
        flexShrink: 0,
        visible: questionChromeVisible(renderer),
    });
    const panel = new BoxRenderable(renderer, {
        id: "question-panel",
        width: "100%",
        height: "auto",
        flexGrow: 1,
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: questionBottomPadding(renderer),
        paddingBottom: questionBottomPadding(renderer),
    });
    panel.add(header);
    panel.add(details);
    panel.add(actions);
    const box = new BoxRenderable(renderer, {
        id: "question-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: 1,
        left: questionSideInset(renderer),
        right: 1,
        height: "auto",
        // Short terminals need the final row that the normal overlay margin
        // would consume. Larger terminals retain the calmer 90% cap.
        maxHeight: renderer.height <= 10 ? "100%" : "90%",
        zIndex: 20,
        flexDirection: "row",
        gap: 0,
        visible: false,
    });
    box.add(bar);
    box.add(panel);

    function renderChoices(update: UserQuestionUiRequestUpdate): void {
        for (const row of choiceRows) {
            row.destroy();
        }
        choiceRows = [];
        update.request.choices.forEach((choice, index) => {
            const row = dialogOptionRow(renderer, {
                label: choice.label,
                leading: `${index + 1}  `,
                active: index === selectedIndex,
                wrap: true,
                ...dialogRowPointer(view.pointer, index + 1),
            });
            choicesColumn.add(row);
            choiceRows.push(row);
        });
        const otherIndex = update.request.choices.length;
        const other = dialogOptionRow(renderer, {
            label: enteringCustom
                ? `Other: ${customText}▌`
                : "Other — type your own answer",
            leading: `${otherIndex + 1}  `,
            active: otherIndex === selectedIndex,
            wrap: true,
            ...dialogRowPointer(view.pointer, otherIndex + 1),
        });
        choicesColumn.add(other);
        choiceRows.push(other);
    }

    const view: TuiQuestionView = {
        box,
        bar,
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
            box.left = questionSideInset(renderer);
            bar.visible = questionChromeVisible(renderer);
            panel.paddingTop = questionBottomPadding(renderer);
            panel.paddingBottom = questionBottomPadding(renderer);
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            selectedIndex = 0;
            enteringCustom = false;
            customText = "";
            detailsText.content = update.request.question;
            choiceAction.content = questionChoiceHint(update);
            renderChoices(update);
            details.scrollTo(0);
        },
        handleKey(update, key): TuiQuestionKeyResult {
            if (hasModifier(key)) {
                return { handled: false };
            }
            const count = update.request.choices.length + 1;
            if (enteringCustom) {
                if (key.name === "escape") {
                    enteringCustom = false;
                    customText = "";
                    renderChoices(update);
                    choiceAction.content = questionChoiceHint(update);
                    return { handled: true };
                }
                if (key.name === "backspace") {
                    customText = [...customText].slice(0, -1).join("");
                    renderChoices(update);
                    return { handled: true };
                }
                if (key.name === "return" || key.name === "enter") {
                    const text = customText.trim();
                    return text.length === 0
                        ? { handled: true }
                        : { handled: true, response: customResponse(update, text) };
                }
                const value = key.sequence ?? key.name;
                if (value.length > 0 && !key.ctrl && !key.meta) {
                    customText += value;
                    renderChoices(update);
                    return { handled: true };
                }
                return { handled: false };
            }
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
                if (choice === undefined && selectedIndex === count - 1) {
                    enteringCustom = true;
                    choiceAction.content = "type answer · ⏎ submit · esc back ";
                    renderChoices(update);
                    return { handled: true };
                }
                return choice === undefined
                    ? { handled: false }
                    : { handled: true, response: selectedResponse(update, choice.id) };
            }
            const directValue = key.sequence?.length === 1
                ? key.sequence
                : key.name;
            if (Number(directValue) - 1 === count - 1) {
                selectedIndex = count - 1;
                enteringCustom = true;
                choiceAction.content = "type answer · ⏎ submit · esc back ";
                renderChoices(update);
                return { handled: true };
            }
            const response = createTuiQuestionResponse(update, key);
            return response === undefined
                ? { handled: false }
                : { handled: true, response };
        },
    };
    return view;
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

function customResponse(
    update: UserQuestionUiRequestUpdate,
    text: string,
): UiResponseCommand {
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "user_question", outcome: "custom", text },
    };
}

function questionChoiceHint(update: UserQuestionUiRequestUpdate): string {
    return `↑↓ move · 1-${update.request.choices.length} or ⏎ choose · other available `;
}

function questionBottomPadding(renderer: RenderContext): number {
    return questionChromeVisible(renderer) ? 1 : 0;
}

function questionChromeVisible(renderer: RenderContext): boolean {
    return renderer.height > DIALOG_SHORT_TERMINAL_HEIGHT;
}

function questionSideInset(renderer: RenderContext): number {
    return questionChromeVisible(renderer) ? 2 : 0;
}

function hasModifier(key: TuiQuestionKey): boolean {
    return key.ctrl === true
        || key.meta === true
        || key.option === true
        || key.shift === true
        || key.super === true
        || key.hyper === true;
}
