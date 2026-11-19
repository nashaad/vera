import {
    BoxRenderable,
    fg,
    ScrollBoxRenderable,
    StyledText,
    TextAttributes,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { dialogHeaderNode } from "./dialog-header.ts";

import type {
    AgentUpdate,
    ToolApprovalUiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";
import {
    isToolApprovalUiRequestUpdate,
    normalizeApprovalNotes,
    TOOL_APPROVAL_NOTES_LIMIT,
} from "../../src/engine/protocol.ts";
import {
    approvalAnswers,
    type ApprovalAnswer,
    type ApprovalAnswersInput,
    type ApprovalDecision,
} from "../shared/approval-answers.ts";
import { approvalReviewText } from "../shared/approval-review.ts";
import {
    TUI_BACKGROUND,
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
    TUI_INPUT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    tuiApprovalBody,
    tuiApprovalBodyText,
    type TuiApprovalTone,
} from "./approval-body.ts";
import {
    approvalBottomPadding,
    approvalChromeVisible,
    approvalHeaderVisible,
    approvalLayout,
} from "./approval-layout.ts";
import { tuiApprovalQuestion } from "./approval-title.ts";
import { tuiBindingId, tuiKeyChordLabel } from "./keymap.ts";
import {
    createTuiSingleLineTextarea,
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";
import {
    attachDialogRowPointer,
    DIALOG_CARD_Z_INDEX,
    DIALOG_SHORT_TERMINAL_HEIGHT,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

const NOTES_PLACEHOLDER = "Tell Vera what to do instead";

// The session facts the answers need; an older host may not have reported them yet.
export interface TuiApprovalSession {
    readonly mode?: string;
    readonly modes?: readonly string[];
}

export interface TuiApprovalKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiApprovalKeyResult {
    readonly handled: boolean;
    readonly response?: UiResponseCommand;
    // Answer 3 sends its allow first, then the session mode change to auto.
    readonly switchToAuto?: true;
}

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    pointer?: DialogRowPointer;
    readonly bar: BoxRenderable;
    readonly headerText: TextRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
    focus(): void;
    update(update: ToolApprovalUiRequestUpdate, session?: TuiApprovalSession): void;
    handleKey(
        update: ToolApprovalUiRequestUpdate,
        key: TuiApprovalKey,
    ): TuiApprovalKeyResult;
    handlePaste(text: string): boolean;
    repaint(): void;
}

interface ApprovalRow {
    readonly key: string;
    readonly answer: ApprovalAnswer;
}

export function createTuiApprovalView(
    renderer: RenderContext,
): TuiApprovalView {
    let currentRequestId: string | undefined;
    let lastUpdate: ToolApprovalUiRequestUpdate | undefined;
    let lastSession: TuiApprovalSession = {};
    let selectedIndex = 0;
    let expanded = false;
    let capped = false;
    let layoutKey = "";
    let editing = false;

    const bar = new BoxRenderable(renderer, {
        id: "approval-bar",
        width: 1,
        border: ["left"],
        borderStyle: "heavy",
        borderColor: TUI_NOTICE,
        flexShrink: 0,
        visible: approvalChromeVisible(renderer),
    });
    const headerText = new TextRenderable(renderer, {
        id: "approval-header-text",
        content: "",
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const detailsText = new TextRenderable(renderer, {
        id: "approval-details-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });
    const details = new ScrollBoxRenderable(renderer, {
        id: "approval-details",
        width: "100%",
        height: "auto",
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 1,
        marginTop: 1,
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        contentOptions: {
            flexDirection: "column",
        },
    });
    details.add(detailsText);

    const buttons = new BoxRenderable(renderer, {
        id: "approval-buttons",
        width: "100%",
        height: "auto",
        flexDirection: "column",
        flexShrink: 0,
    });
    const hints = new TextRenderable(renderer, {
        id: "approval-hints",
        content: "",
        height: 1,
        marginTop: 1,
        flexShrink: 1,
        overflow: "hidden",
        wrapMode: "none",
    });
    const actions = new BoxRenderable(renderer, {
        id: "approval-actions",
        width: "100%",
        height: "auto",
        marginTop: 1,
        flexShrink: 0,
        flexDirection: "column",
    });
    actions.add(buttons);
    actions.add(hints);

    const content = new BoxRenderable(renderer, {
        id: "approval-content",
        flexGrow: 1,
        flexDirection: "column",
        gap: 0,
        paddingTop: 0,
        paddingBottom: approvalBottomPadding(renderer),
        paddingLeft: 2,
        paddingRight: 2,
    });
    const header = dialogHeaderNode(renderer, headerText, "");
    content.add(header);
    content.add(details);
    content.add(actions);
    content.minHeight = 0;
    content.flexShrink = 1;

    const box = new BoxRenderable(renderer, {
        id: "approval-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "auto",
        maxHeight: renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT
            ? "100%"
            : "90%",
        zIndex: DIALOG_CARD_Z_INDEX,
        flexDirection: "row",
        visible: false,
    });
    box.add(bar);
    box.add(content);

    const notesEditor = createTuiSingleLineTextarea(renderer, {
        id: "approval-notes",
        placeholder: NOTES_PLACEHOLDER,
    });
    const notesEditorBox = new BoxRenderable(renderer, {
        id: "approval-notes-box",
        height: 1,
        flexGrow: 1,
        flexShrink: 1,
        backgroundColor: TUI_INPUT,
        paddingLeft: 1,
        paddingRight: 1,
    });
    notesEditorBox.add(notesEditor);
    const notesLine = new BoxRenderable(renderer, {
        id: "approval-notes-line",
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
    });
    notesLine.add(notesEditorBox);

    let buttonNodes: TextRenderable[] = [];

    function stopEditing(): void {
        editing = false;
        notesEditor.setText("");
        details.focus();
    }

    function startEditing(update: ToolApprovalUiRequestUpdate): void {
        if (!typedAnswerAvailable(update)) {
            return;
        }
        editing = true;
        notesEditor.focus();
        renderChrome(update);
    }

    function clipNotes(): void {
        const text = notesEditor.plainText;
        if (text.length <= TOOL_APPROVAL_NOTES_LIMIT) {
            return;
        }
        notesEditor.setText(text.slice(0, TOOL_APPROVAL_NOTES_LIMIT));
        notesEditor.gotoBufferEnd();
    }

    function renderButtons(update: ToolApprovalUiRequestUpdate): void {
        notesLine.parent?.remove(notesLine.id);
        for (const node of buttonNodes) {
            node.destroyRecursively();
        }
        buttonNodes = [];
        const rows = approvalRows(update, lastSession);
        for (const [index, row] of rows.entries()) {
            const active = index === selectedIndex;
            const node = new TextRenderable(renderer, {
                content: new StyledText([
                    fg(active ? TUI_BACKGROUND : TUI_MUTED)(approvalRowText(row)),
                ]),
                bg: active ? TUI_NOTICE : TUI_PANEL,
                attributes: active
                    ? TextAttributes.BOLD
                    : TextAttributes.NONE,
                width: "100%",
                height: 1,
                flexShrink: 0,
                wrapMode: "none",
                overflow: "hidden",
            });
            if (!editing) {
                attachDialogRowPointer(node, view.pointer, index + 1);
            }
            buttons.add(node);
            buttonNodes.push(node);
        }
        if (editing) {
            buttons.add(notesLine);
        }
    }

    function renderBody(update: ToolApprovalUiRequestUpdate): void {
        const body = tuiApprovalBody(update, expanded);
        const reason = approvalReason(update);
        capped = expanded || body.hidden > 0;
        detailsText.content = new StyledText(
            [
                ...(reason === undefined ? [] : [{ text: reason, tone: "muted" as const }]),
                ...body.lines,
            ].flatMap((line, index, lines) => [
                fg(toneColor(line.tone))(line.text),
                ...(index === lines.length - 1 ? [] : [fg(TUI_TEXT)("\n")]),
            ]),
        );
    }

    function renderChrome(update: ToolApprovalUiRequestUpdate): void {
        bar.borderColor = TUI_NOTICE;
        box.backgroundColor = TUI_PANEL;
        detailsText.fg = TUI_TEXT;
        const headline = tuiApprovalQuestion(update);
        const title = headline?.question
            ?? `Permission required  ${update.request.toolCall.name}`;
        const layout = approvalLayout({
            width: renderer.width,
            height: renderer.height,
            rows: approvalRows(update, lastSession).length,
            title,
            ...(headline?.folder === undefined
                ? {}
                : { folderLine: `in ${headline.folder}` }),
        });
        headerText.content = new StyledText(
            headline === undefined
                ? [
                    fg(TUI_NOTICE)("Permission required"),
                    fg(TUI_MUTED)(`  ${update.request.toolCall.name}`),
                ]
                : [
                    fg(TUI_NOTICE)(headline.question),
                    ...(headline.folder === undefined || !layout.folder
                        ? []
                        : [fg(TUI_MUTED)(`\nin ${headline.folder}`)]),
                ],
        );
        actions.marginTop = layout.gap;
        notesEditorBox.backgroundColor = TUI_INPUT;
        notesEditor.textColor = TUI_TEXT;
        notesEditor.focusedTextColor = TUI_TEXT;
        notesEditor.backgroundColor = TUI_INPUT;
        notesEditor.focusedBackgroundColor = TUI_INPUT;
        hints.content = new StyledText([
            ...(editing
                ? [
                    fg(TUI_TEXT)("enter"),
                    fg(TUI_MUTED)(" send  "),
                    fg(TUI_TEXT)("esc"),
                    fg(TUI_MUTED)(" back"),
                ]
                : [
                    ...(typedAnswerAvailable(update)
                        ? [
                            fg(TUI_TEXT)(approvalNotesChordLabel()),
                            fg(TUI_MUTED)(" to tell Vera what to do instead · "),
                        ]
                        : []),
                    fg(TUI_TEXT)("Esc"),
                    fg(TUI_MUTED)(" to deny"),
                ]),
            ...(capped
                ? [
                    fg(TUI_TEXT)(`  ${tuiKeyChordLabel("expand_call")}`),
                    fg(TUI_MUTED)(expanded ? " collapse" : " expand"),
                ]
                : []),
        ]);
        hints.visible = layout.hints;
        renderButtons(update);
    }

    function handleNotesKey(
        update: ToolApprovalUiRequestUpdate,
        key: TuiApprovalKey,
        binding: string | undefined,
    ): TuiApprovalKeyResult {
        if (key.name === "escape" || binding === "approval_notes") {
            stopEditing();
            renderChrome(update);
            return { handled: true };
        }
        if (key.name === "return" || key.name === "enter") {
            const response = createTuiApprovalNotesResponse(
                update,
                notesEditor.plainText,
            );
            return response === undefined
                ? { handled: true }
                : { handled: true, response };
        }
        if (
            isTypedCharacter(key)
            && notesEditor.plainText.length >= TOOL_APPROVAL_NOTES_LIMIT
        ) {
            return { handled: true };
        }
        if (notesEditor.handleKeyPress(tuiTextareaKey(key))) {
            clipNotes();
            return { handled: true };
        }
        return { handled: false };
    }

    const view: TuiApprovalView = {
        box,
        bar,
        headerText,
        details,
        detailsText,
        actions,
        focus(): void {
            if (editing) {
                notesEditor.focus();
                return;
            }
            details.focus();
        },
        update(update, session = {}): void {
            lastUpdate = update;
            lastSession = session;
            box.maxHeight = renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT
                ? "100%"
                : "90%";
            bar.visible = approvalChromeVisible(renderer);
            header.visible = approvalHeaderVisible(renderer);
            content.paddingTop = 0;
            content.paddingBottom = approvalBottomPadding(renderer);
            details.marginTop = 0;
            const nextKey = [
                renderer.width,
                renderer.height,
                session.mode ?? "",
                (session.modes ?? []).join(","),
            ].join(":");
            if (currentRequestId === update.requestId) {
                if (nextKey !== layoutKey) {
                    layoutKey = nextKey;
                    clampSelection(update);
                    renderBody(update);
                    renderChrome(update);
                }
                return;
            }
            currentRequestId = update.requestId;
            layoutKey = nextKey;
            selectedIndex = 0;
            expanded = false;
            if (editing) {
                stopEditing();
            }
            renderBody(update);
            renderChrome(update);
            details.scrollTo(0);
        },
        handleKey(update, key): TuiApprovalKeyResult {
            const binding = tuiBindingId("approval", key);
            if (binding === "expand_call") {
                expanded = !expanded;
                renderBody(update);
                renderChrome(update);
                return { handled: true };
            }
            if (editing) {
                return handleNotesKey(update, key, binding);
            }
            if (binding === "approval_notes") {
                startEditing(update);
                return { handled: true };
            }
            if (key.ctrl || key.meta || key.shift) {
                return { handled: false };
            }
            const rows = approvalRows(update, lastSession);
            if (
                key.name === "up"
                || key.name === "down"
                || key.name === "left"
                || key.name === "right"
            ) {
                const next = key.name === "up" || key.name === "left"
                    ? Math.max(0, selectedIndex - 1)
                    : Math.min(rows.length - 1, selectedIndex + 1);
                if (next !== selectedIndex) {
                    selectedIndex = next;
                    renderButtons(update);
                }
                return { handled: true };
            }
            if (key.name === "return" || key.name === "enter") {
                const row = rows[selectedIndex];
                return row === undefined
                    ? { handled: true }
                    : answerResult(update, row.answer);
            }
            if (key.name === "escape") {
                return {
                    handled: true,
                    response: approvalResponse(update, "deny"),
                };
            }
            const row = rows.find((candidate) => candidate.key === key.name);
            return row === undefined
                ? { handled: false }
                : answerResult(update, row.answer);
        },
        handlePaste(text): boolean {
            if (!editing) {
                return false;
            }
            const room = TOOL_APPROVAL_NOTES_LIMIT - notesEditor.plainText.length;
            if (room > 0) {
                insertTuiSingleLinePaste(notesEditor, text.slice(0, room));
                clipNotes();
            }
            return true;
        },
        repaint(): void {
            if (lastUpdate === undefined) {
                return;
            }
            clampSelection(lastUpdate);
            renderBody(lastUpdate);
            renderChrome(lastUpdate);
        },
    };

    function clampSelection(update: ToolApprovalUiRequestUpdate): void {
        const count = approvalRows(update, lastSession).length;
        selectedIndex = Math.min(selectedIndex, Math.max(0, count - 1));
    }

    return view;
}

function answerResult(
    update: ToolApprovalUiRequestUpdate,
    answer: ApprovalAnswer,
): TuiApprovalKeyResult {
    const result: TuiApprovalKeyResult = {
        handled: true,
        response: approvalResponse(update, answer.decision),
    };
    return answer.switchToAuto === true
        ? { ...result, switchToAuto: true }
        : result;
}

function approvalRowText(row: ApprovalRow): string {
    return ` ${row.key} ${row.answer.label} `;
}

export function approvalRows(
    update: ToolApprovalUiRequestUpdate,
    session: TuiApprovalSession = {},
): readonly ApprovalRow[] {
    return approvalAnswers(answerInput(update, session)).map((answer, index) => ({
        key: String(index + 1),
        answer,
    }));
}

export function answerInput(
    update: ToolApprovalUiRequestUpdate,
    session: TuiApprovalSession = {},
): ApprovalAnswersInput {
    return {
        grants: (update.request.permissionGrants ?? []).map((grant) => grant.when),
        subagent: isSubagentCall(update),
        restricted: update.request.restrictedChoices === true,
        mode: session.mode ?? "",
        modes: session.modes ?? [],
    };
}

export function typedAnswerAvailable(
    update: ToolApprovalUiRequestUpdate,
): boolean {
    return !isSubagentCall(update) && update.request.allowNotes !== false;
}

function isSubagentCall(update: ToolApprovalUiRequestUpdate): boolean {
    return update.request.sourceAgentId !== undefined
        || update.request.sourceTask !== undefined;
}

export function renderTuiApproval(
    update: ToolApprovalUiRequestUpdate,
    session: TuiApprovalSession = {},
): string {
    const reason = approvalReason(update);
    const headline = tuiApprovalQuestion(update);
    return [
        ...(headline === undefined
            ? [`Permission required · ${update.request.toolCall.name}`]
            : [
                headline.question,
                ...(headline.folder === undefined ? [] : [`in ${headline.folder}`]),
            ]),
        ...(reason === undefined ? [] : [reason]),
        "",
        renderTuiApprovalDetails(update),
        "",
        ...approvalRows(update, session)
            .map((row) => `${row.key} ${row.answer.label}`),
    ].join("\n");
}

export function renderTuiApprovalDetails(
    update: ToolApprovalUiRequestUpdate,
    expanded = false,
): string {
    return tuiApprovalBodyText(update, expanded);
}

export function selectableApprovalKeys(
    update: ToolApprovalUiRequestUpdate,
    session: TuiApprovalSession = {},
): readonly string[] {
    return approvalRows(update, session).map((row) => row.key);
}

function approvalResponse(
    update: ToolApprovalUiRequestUpdate,
    decision: ApprovalDecision,
): UiResponseCommand {
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision },
    };
}

export function createTuiApprovalNotesResponse(
    update: ToolApprovalUiRequestUpdate,
    text: string,
): UiResponseCommand | undefined {
    const notes = normalizeApprovalNotes(text);
    if (notes === undefined || !typedAnswerAvailable(update)) {
        return undefined;
    }
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision: "deny", notes },
    };
}

function isTypedCharacter(key: TuiApprovalKey): boolean {
    const typed = key.sequence ?? (key.name.length === 1 ? key.name : "");
    return !key.ctrl && !key.meta && !key.option
        && [...typed].length === 1 && typed >= " " && typed !== "\x7f";
}

export function applyTuiApprovalUpdate(
    current: ToolApprovalUiRequestUpdate | undefined,
    update: AgentUpdate,
): ToolApprovalUiRequestUpdate | undefined {
    if (
        update.type === "ui_request"
        && isToolApprovalUiRequestUpdate(update)
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

function toneColor(tone: TuiApprovalTone): string {
    if (tone === "add") return TUI_DIFF_ADDED;
    if (tone === "del") return TUI_DIFF_REMOVED;
    if (tone === "muted" || tone === "path") return TUI_MUTED;
    return TUI_TEXT;
}

function approvalNotesChordLabel(): string {
    const label = tuiKeyChordLabel("approval_notes");
    return label.charAt(0).toUpperCase() + label.slice(1);
}

export function tuiApprovalHint(
    update: ToolApprovalUiRequestUpdate,
): string {
    if (!typedAnswerAvailable(update)) {
        return "approval required · Esc deny · Ctrl+C stop";
    }
    return `approval required · ${approvalNotesChordLabel()} tell Vera · Esc deny · Ctrl+C stop`;
}

function approvalReason(update: ToolApprovalUiRequestUpdate): string | undefined {
    if (update.request.review !== undefined) return approvalReviewText(update.request.review);
    const reason = update.request.reason;
    return reason.startsWith("Permission mode ") ? undefined : reason;
}
