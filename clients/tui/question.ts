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
import { tuiBindingId } from "./keymap.ts";

/**
 * Below this the panel is too narrow to seat a choice list and a preview box
 * side by side, so the preview goes under the choices instead.
 */
const QUESTION_TWO_COLUMN_WIDTH = 80;

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
    let enteringNotes = false;
    let notesText = "";
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
    const previewText = new TextRenderable(renderer, {
        id: "question-preview-text",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "none",
        selectable: true,
    });
    // The preview is the asker's own rendering of a choice, so it gets a box
    // and a monospace grid and no styling of its own.
    const preview = new BoxRenderable(renderer, {
        id: "question-preview",
        height: "auto",
        flexGrow: 1,
        flexShrink: 1,
        marginLeft: 2,
        paddingLeft: 1,
        paddingRight: 1,
        border: true,
        borderColor: TUI_MUTED,
        visible: false,
    });
    preview.add(previewText);
    // Choices and their preview sit side by side while the panel is wide
    // enough for both, and stack when it is not.
    const choicesRow = new BoxRenderable(renderer, {
        id: "question-choices-row",
        width: "100%",
        height: "auto",
        flexShrink: 0,
        flexDirection: "row",
    });
    choicesRow.add(choicesColumn);
    choicesRow.add(preview);

    const notes = new TextRenderable(renderer, {
        id: "question-notes",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        marginTop: 1,
        flexShrink: 0,
        wrapMode: "word",
        visible: false,
    });

    details.add(detailsText);
    details.add(choicesRow);
    details.add(notes);

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
        renderPreview(update);
        renderNotes();
    }

    /** The highlighted choice's own rendering, when it brought one. */
    function renderPreview(update: UserQuestionUiRequestUpdate): void {
        const content = update.request.choices[selectedIndex]?.preview;
        preview.visible = content !== undefined;
        previewText.content = content ?? "";
    }

    function renderNotes(): void {
        notes.visible = enteringNotes || notesText.length > 0;
        notes.content = enteringNotes
            ? `Notes: ${notesText}▌`
            : `Notes: ${notesText}`;
    }

    /**
     * Two columns need room for both. Below that the preview keeps its box but
     * takes the full width under the choices, which is the same fallback the
     * approval panel makes for a predicate its row cannot hold: content that
     * does not fit moves, it is not clipped away.
     */
    function applyLayout(): void {
        const stacked = renderer.width < QUESTION_TWO_COLUMN_WIDTH;
        choicesRow.flexDirection = stacked ? "column" : "row";
        choicesColumn.width = stacked ? "100%" : "50%";
        preview.marginLeft = stacked ? 0 : 2;
        preview.marginTop = stacked ? 1 : 0;
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
            applyLayout();
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            selectedIndex = 0;
            enteringCustom = false;
            customText = "";
            enteringNotes = false;
            notesText = "";
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
            // Notes ride alongside a choice rather than replacing it, so the
            // highlight stays where it is and ⏎ still answers.
            if (enteringNotes) {
                if (key.name === "escape" || notesBinding(key)) {
                    enteringNotes = false;
                    choiceAction.content = questionChoiceHint(update);
                    renderNotes();
                    return { handled: true };
                }
                if (key.name === "backspace") {
                    notesText = [...notesText].slice(0, -1).join("");
                    renderNotes();
                    return { handled: true };
                }
                if (key.name === "return" || key.name === "enter") {
                    const choice = update.request.choices[selectedIndex];
                    return choice === undefined
                        ? { handled: true }
                        : {
                            handled: true,
                            response: selectedResponse(
                                update,
                                choice.id,
                                notesText.trim(),
                            ),
                        };
                }
                const typed = key.sequence ?? key.name;
                if (typed.length === 1) {
                    notesText += typed;
                    renderNotes();
                    return { handled: true };
                }
                return { handled: false };
            }
            if (notesBinding(key) && !enteringCustom) {
                enteringNotes = true;
                choiceAction.content = "type notes · ⏎ answer · esc back ";
                renderNotes();
                return { handled: true };
            }
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
    notes?: string,
): UiResponseCommand {
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId,
            ...(notes === undefined || notes.length === 0 ? {} : { notes }),
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
    return `↑↓ move · 1-${update.request.choices.length} or ⏎ choose · tab notes `;
}

/** Tab is claimed through the table, so nothing else can quietly take it. */
function notesBinding(key: TuiQuestionKey): boolean {
    return tuiBindingId("question", key) === "write_notes";
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
