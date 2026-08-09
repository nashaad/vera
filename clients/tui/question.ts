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
import {
    attachDialogRowPointer,
    DIALOG_GUTTER_WIDTH,
    DIALOG_SHORT_TERMINAL_HEIGHT,
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

// Two row-padding cells and the three-cell number gutter leave at most 87
// cells for choice text, while `width: "100%"` still fills narrow terminals.
export const QUESTION_CHOICE_MAX_WIDTH = 92;

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
        fg: TUI_ACCENT,
        attributes: 1,
        // The gutter the choice rows below already carry, so the question and
        // the answers to it start on the same column.
        marginLeft: DIALOG_GUTTER_WIDTH,
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });
    const choicesColumn = new BoxRenderable(renderer, {
        id: "question-choices",
        width: "100%",
        maxWidth: QUESTION_CHOICE_MAX_WIDTH,
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
    // The preview is the asker's own rendering of a choice, so it keeps a
    // monospace grid and no styling of its own. No frame either: the gap
    // between the columns already says where the choices end.
    const preview = new BoxRenderable(renderer, {
        id: "question-preview",
        height: "auto",
        flexGrow: 1,
        flexShrink: 1,
        marginLeft: 2,
        border: false,
        alignItems: "center",
        justifyContent: "center",
        visible: false,
    });
    const previewContent = new BoxRenderable(renderer, {
        id: "question-preview-content",
        width: 1,
        height: "auto",
        flexShrink: 0,
    });
    previewContent.add(previewText);
    preview.add(previewContent);
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
        marginLeft: DIALOG_GUTTER_WIDTH,
        height: "auto",
        marginTop: 1,
        flexShrink: 0,
        wrapMode: "word",
        visible: false,
    });

    // The question sits above the scroll region, not in it: it is the card's
    // heading, and a heading that scrolls away leaves a list of answers to a
    // question the reader can no longer see.
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
        content: "· esc dismiss",
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
        // The hints are a separate register from the answers, so they get a
        // blank row rather than sitting against the last one.
        marginTop: questionBottomPadding(renderer),
        flexDirection: "row",
        flexWrap: "wrap",
    });
    actions.add(choiceAction);
    actions.add(cancelAction);
    // The same heavy left edge the composer draws, rather than a filled cell:
    // a filled cell is a whole character wide and reads as a slab next to it.
    const bar = new BoxRenderable(renderer, {
        id: "question-bar",
        width: 1,
        border: ["left"],
        borderStyle: "heavy",
        borderColor: TUI_ACCENT,
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
    panel.add(detailsText);
    panel.add(details);
    panel.add(actions);
    const box = new BoxRenderable(renderer, {
        id: "question-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: 0,
        left: questionSideInset(renderer),
        right: questionSideInset(renderer),
        height: "auto",
        // Short terminals need the final row that the normal overlay margin
        // would consume. Larger terminals retain the calmer 90% cap. The cap
        // counts the row the card is held off the floor by: a full-height card
        // that also sits one row up overhangs the top, and the first row is the
        // question.
        maxHeight: questionMaxHeight(renderer),
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
            const row = questionChoiceRow(renderer, {
                number: index + 1,
                label: choice.label,
                description: choice.description,
                active: index === selectedIndex,
                pointer: view.pointer,
            });
            choicesColumn.add(row);
            choiceRows.push(row);
        });
        const otherIndex = update.request.choices.length;
        const other = questionChoiceRow(renderer, {
            number: otherIndex + 1,
            label: "Other",
            answer: enteringCustom ? `${customText}▌` : undefined,
            active: otherIndex === selectedIndex,
            pointer: view.pointer,
        });
        choicesColumn.add(other);
        choiceRows.push(other);
        renderPreview(update);
        renderNotes();
    }

    /** The highlighted choice's own rendering, when it brought one. */
    function renderPreview(update: UserQuestionUiRequestUpdate): void {
        const content = update.request.choices[selectedIndex]?.preview;
        const ownPane = previewWantsOwnPane(content);
        preview.visible = ownPane;
        previewText.content = ownPane ? content ?? "" : "";
        previewContent.width = ownPane ? previewWidth(content ?? "") : 1;
        previewContent.height = ownPane ? previewHeight(content ?? "") : 1;
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
        preview.alignItems = stacked ? "flex-start" : "center";
        preview.justifyContent = stacked ? "flex-start" : "center";
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
            box.maxHeight = questionMaxHeight(renderer);
            box.left = questionSideInset(renderer);
            box.right = questionSideInset(renderer);
            bar.visible = questionChromeVisible(renderer);
            panel.paddingTop = questionBottomPadding(renderer);
            panel.paddingBottom = questionBottomPadding(renderer);
            actions.marginTop = questionBottomPadding(renderer);
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
            choiceAction.content = questionChoiceHint();
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
                    choiceAction.content = questionChoiceHint();
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
                    choiceAction.content = questionChoiceHint();
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

function questionChoiceHint(): string {
    return "↑↓ select · enter submit · tab notes ";
}

interface QuestionChoiceRow {
    readonly number: number;
    readonly label: string;
    /** What the reader has typed so far, when the row is the custom one. */
    readonly answer?: string;
    readonly description?: string;
    readonly active: boolean;
    readonly pointer?: DialogRowPointer;
}

/**
 * A choice as two stacked lines: a numbered label, and under it what picking it
 * means. The highlight sits behind the label rather than across the card, so a
 * short answer does not paint a bar into empty space; the number keeps its own
 * colour either way, so the column reads as a column down the whole list.
 */
function questionChoiceRow(
    renderer: RenderContext,
    content: QuestionChoiceRow,
): BoxRenderable {
    const row = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "column",
    });
    attachDialogRowPointer(row, content.pointer, content.number);
    const line = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "row",
    });
    line.add(new TextRenderable(renderer, {
        content: new StyledText([fg(TUI_MUTED)(`${content.number}. `)]),
        flexShrink: 0,
    }));
    line.add(new TextRenderable(renderer, {
        content: new StyledText([fg(TUI_ACCENT)(content.label)]),
        bg: content.active ? TUI_ELEMENT : TUI_PANEL,
        attributes: content.active ? 1 : 0,
        // The node takes the row's remaining width, which is what gives a long
        // label a boundary to wrap on; shrinking it to its own text instead
        // leaves the wrap nothing to measure against and the label is cut at
        // one line. The highlight still ends where the answer does, because a
        // text node paints only the cells its glyphs fill.
        // A row that carries a typed answer gives the label only its own width,
        // so the answer has somewhere to sit.
        flexGrow: content.answer === undefined ? 1 : 0,
        flexShrink: content.answer === undefined ? 1 : 0,
        height: "auto",
        wrapMode: "word",
    }));
    if (content.answer !== undefined) {
        // Outside the highlighted label: what the reader typed is their own
        // words, not one of the offered answers, so it is not dressed as one.
        line.add(new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_TEXT)(`: ${content.answer}`)]),
            flexShrink: 0,
        }));
    }
    row.add(line);
    if (content.description !== undefined) {
        row.add(new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_MUTED)(content.description)]),
            // Under the label, not under the number: the description belongs to
            // the answer, and the number column stays clear down the list.
            marginLeft: QUESTION_NUMBER_WIDTH,
            width: "100%",
            height: "auto",
            wrapMode: "word",
        }));
    }
    return row;
}

/**
 * A single line is not a visual preview, even when fenced as one. Multiline
 * renderings keep their own pane so diagrams, diffs, and snippets preserve
 * their grid; stray prose stays out of the question entirely.
 */
function previewWantsOwnPane(content: string | undefined): boolean {
    if (content === undefined) {
        return false;
    }
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
        return false;
    }
    return !isFencedOneLine(lines);
}

function isFencedOneLine(lines: readonly string[]): boolean {
    if (lines.length !== 3) {
        return false;
    }
    const opening = lines[0]?.trimStart() ?? "";
    const marker = /^(`{3,}|~{3,})/.exec(opening)?.[1];
    const closing = lines[2]?.trim() ?? "";
    if (marker === undefined || closing.length < marker.length) {
        return false;
    }
    return [...closing].every((character) => character === marker[0]);
}

function previewWidth(content: string): number {
    return Math.max(
        1,
        ...content.split("\n").map((line) => Bun.stringWidth(line)),
    );
}

function previewHeight(content: string): number {
    return Math.max(1, content.split("\n").length);
}

/** The number, its period, and the space after it. */
const QUESTION_NUMBER_WIDTH = 3;


/** Tab is claimed through the table, so nothing else can quietly take it. */
function notesBinding(key: TuiQuestionKey): boolean {
    return tuiBindingId("question", key) === "write_notes";
}

function questionMaxHeight(renderer: RenderContext): number | `${number}%` {
    return renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT
        ? renderer.height - QUESTION_BOTTOM_OFFSET
        : "90%";
}

/** How far the card is held off the floor, in rows. */
const QUESTION_BOTTOM_OFFSET = 0;

function questionBottomPadding(renderer: RenderContext): number {
    return questionChromeVisible(renderer) ? 1 : 0;
}

function questionChromeVisible(renderer: RenderContext): boolean {
    return renderer.height > DIALOG_SHORT_TERMINAL_HEIGHT;
}

// The card spans the terminal. A gutter around it reads as a frame, and a
// frame is the one thing the card is not: it is the bottom of the session.
function questionSideInset(_renderer: RenderContext): number {
    return 0;
}

function hasModifier(key: TuiQuestionKey): boolean {
    return key.ctrl === true
        || key.meta === true
        || key.option === true
        || key.shift === true
        || key.super === true
        || key.hyper === true;
}
