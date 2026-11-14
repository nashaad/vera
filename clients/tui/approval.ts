import {
    BoxRenderable,
    fg,
    ScrollBoxRenderable,
    StyledText,
    TextAttributes,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { AUTO_NUDGE_KEY, AUTO_NUDGE_LINE } from "./auto-nudge.ts";
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
    describeGrantPredicate,
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

const NOTES_KEY = "5";
const NOTES_LABEL = "Tell Vera what to do instead";

const APPROVAL_ROWS = [
    { key: "1", label: "Allow" },
    { key: "2", label: "Allow for this chat" },
    { key: "3", label: "Deny" },
    { key: "4", label: "Always allow" },
    { key: NOTES_KEY, label: NOTES_LABEL },
] as const;

export type TuiApprovalDecision =
    | "allow_once"
    | "allow_similar"
    | "allow_always"
    | "deny";

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
    readonly switchToAuto?: true;
}

// Below this height the card has no room for the suggestion without squeezing the request.
const NUDGE_MIN_HEIGHT = 16;
const NUDGE_ROWS = 2;

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    pointer?: DialogRowPointer;
    readonly bar: BoxRenderable;
    readonly headerText: TextRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
    readonly nudgeText: TextRenderable;
    focus(): void;
    // The second argument asks for the auto-approval suggestion; it shows only when the terminal has room.
    update(update: ToolApprovalUiRequestUpdate, suggestAuto?: boolean): void;
    autoNudgeVisible(): boolean;
    handleKey(
        update: ToolApprovalUiRequestUpdate,
        key: TuiApprovalKey,
    ): TuiApprovalKeyResult;
    handlePaste(text: string): boolean;
    repaint(): void;
}

export function createTuiApprovalView(
    renderer: RenderContext,
): TuiApprovalView {
    let currentRequestId: string | undefined;
    let lastUpdate: ToolApprovalUiRequestUpdate | undefined;
    let selectedKey: string = "1";
    let expanded = false;
    let capped = false;
    let scopeInline = true;
    let layoutKey = "";
    let editing = false;
    let nudgeVisible = false;

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
    const nudgeText = new TextRenderable(renderer, {
        id: "approval-nudge",
        content: "",
        width: "100%",
        height: "auto",
        marginTop: 1,
        flexShrink: 0,
        wrapMode: "word",
        visible: false,
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
    actions.add(nudgeText);
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

    const notesLabel = new TextRenderable(renderer, {
        id: "approval-notes-label",
        content: ` ${NOTES_KEY} `,
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
    });
    const notesEditor = createTuiSingleLineTextarea(renderer, {
        id: "approval-notes",
        placeholder: NOTES_LABEL,
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
    notesLine.add(notesLabel);
    notesLine.add(notesEditorBox);

    let buttonNodes: TextRenderable[] = [];

    function stopEditing(): void {
        editing = false;
        notesEditor.setText("");
        details.focus();
    }

    function startEditing(update: ToolApprovalUiRequestUpdate): void {
        editing = true;
        selectedKey = NOTES_KEY;
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
        const available = selectableApprovalKeys(update);
        for (const action of visibleApprovalRows(update)) {
            if (editing && action.key === NOTES_KEY) {
                buttons.add(notesLine);
                continue;
            }
            const active = action.key === selectedKey;
            const selectable = available.includes(action.key);
            const node = new TextRenderable(renderer, {
                content: new StyledText([
                    fg(active ? TUI_BACKGROUND : TUI_MUTED)(
                        approvalRowText(update, action, scopeInline),
                    ),
                ]),
                bg: active ? TUI_NOTICE : TUI_PANEL,
                attributes: active
                    ? TextAttributes.BOLD
                    : selectable ? TextAttributes.NONE : TextAttributes.DIM,
                width: "100%",
                height: 1,
                flexShrink: 0,
                wrapMode: "none",
                overflow: "hidden",
            });
            if (selectable && !editing) {
                attachDialogRowPointer(node, view.pointer, Number(action.key));
            }
            buttons.add(node);
            buttonNodes.push(node);
        }
    }

    function renderBody(update: ToolApprovalUiRequestUpdate): void {
        const body = tuiApprovalBody(update, expanded, scopeInline);
        const reason = specificReason(update.request.reason);
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
            rows: visibleApprovalRows(update).length,
            extraRows: nudgeVisible ? NUDGE_ROWS : 0,
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
        notesLabel.fg = TUI_BACKGROUND;
        notesLabel.bg = TUI_NOTICE;
        notesLabel.attributes = TextAttributes.BOLD;
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
                    fg(TUI_TEXT)("up/down"),
                    fg(TUI_MUTED)(" select  "),
                    fg(TUI_TEXT)("enter"),
                    fg(TUI_MUTED)(" confirm  "),
                    fg(TUI_TEXT)("esc"),
                    fg(TUI_MUTED)(" deny"),
                ]),
            ...(capped
                ? [
                    fg(TUI_TEXT)("  Ctrl+R"),
                    fg(TUI_MUTED)(expanded ? " collapse" : " expand"),
                ]
                : []),
        ]);
        hints.visible = layout.hints;
        nudgeText.content = new StyledText([
            fg(TUI_MUTED)(`${AUTO_NUDGE_LINE}  `),
            fg(TUI_TEXT)(AUTO_NUDGE_KEY),
            fg(TUI_MUTED)(" switch"),
        ]);
        nudgeText.visible = nudgeVisible;
        renderButtons(update);
    }

    function handleNotesKey(
        update: ToolApprovalUiRequestUpdate,
        key: TuiApprovalKey,
    ): TuiApprovalKeyResult {
        if (key.name === "escape") {
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
        nudgeText,
        focus(): void {
            if (editing) {
                notesEditor.focus();
                return;
            }
            details.focus();
        },
        autoNudgeVisible(): boolean {
            return nudgeVisible;
        },
        update(update, suggestAuto = false): void {
            lastUpdate = update;
            nudgeVisible = suggestAuto && renderer.height >= NUDGE_MIN_HEIGHT;
            nudgeText.visible = nudgeVisible;
            box.maxHeight = renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT
                ? "100%"
                : "90%";
            const inline = scopeFitsRow(renderer, update);
            bar.visible = approvalChromeVisible(renderer);
            header.visible = approvalHeaderVisible(renderer);
            content.paddingTop = 0;
            content.paddingBottom = approvalBottomPadding(renderer);
            details.marginTop = 0;
            const nextKey = [
                renderer.width,
                renderer.height,
                inline,
                nudgeVisible,
            ].join(":");
            if (currentRequestId === update.requestId) {
                if (nextKey !== layoutKey) {
                    layoutKey = nextKey;
                    scopeInline = inline;
                    renderBody(update);
                    renderChrome(update);
                }
                return;
            }
            currentRequestId = update.requestId;
            layoutKey = nextKey;
            scopeInline = inline;
            selectedKey = "1";
            expanded = false;
            if (editing) {
                stopEditing();
            }
            renderBody(update);
            renderChrome(update);
            details.scrollTo(0);
        },
        handleKey(update, key): TuiApprovalKeyResult {
            if (key.ctrl && !key.meta && !key.shift && key.name === "r") {
                expanded = !expanded;
                renderBody(update);
                renderChrome(update);
                return { handled: true };
            }
            if (editing) {
                return handleNotesKey(update, key);
            }
            if (key.ctrl || key.meta || key.shift) {
                return { handled: false };
            }
            if (nudgeVisible && key.name === AUTO_NUDGE_KEY) {
                return { handled: true, switchToAuto: true };
            }
            if (
                key.name === "up"
                || key.name === "down"
                || key.name === "left"
                || key.name === "right"
            ) {
                const keys = selectableApprovalKeys(update);
                const index = Math.max(0, keys.indexOf(selectedKey));
                const next = key.name === "up" || key.name === "left"
                    ? Math.max(0, index - 1)
                    : Math.min(keys.length - 1, index + 1);
                if (keys[next] !== undefined && keys[next] !== selectedKey) {
                    selectedKey = keys[next];
                    renderButtons(update);
                }
                return { handled: true };
            }
            if (key.name === "return" || key.name === "enter") {
                if (selectedKey === NOTES_KEY) {
                    startEditing(update);
                    return { handled: true };
                }
                const response = createTuiApprovalResponse(update, {
                    name: selectedKey,
                });
                return response === undefined
                    ? { handled: true }
                    : { handled: true, response };
            }
            if (
                key.name === NOTES_KEY
                && selectableApprovalKeys(update).includes(NOTES_KEY)
            ) {
                startEditing(update);
                return { handled: true };
            }
            const response = createTuiApprovalResponse(update, key);
            return response === undefined
                ? { handled: false }
                : { handled: true, response };
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
            renderBody(lastUpdate);
            renderChrome(lastUpdate);
        },
    };
    return view;
}

function scopeFitsRow(
    renderer: RenderContext,
    update: ToolApprovalUiRequestUpdate,
): boolean {
    if (grantScope(update) === undefined) {
        return true;
    }
    const row = APPROVAL_ROWS.find((action) => action.key === "2");
    if (row === undefined) {
        return true;
    }
    const chrome = approvalChromeVisible(renderer) ? 1 : 0;
    const padding = 4;
    const available = renderer.width
        - chrome
        - padding;
    return approvalRowText(update, row, true).length <= available;
}

function approvalRowText(
    update: ToolApprovalUiRequestUpdate,
    action: (typeof APPROVAL_ROWS)[number],
    inlineScope: boolean,
): string {
    return ` ${action.key} ${approvalRowLabel(update, action, inlineScope)} `;
}

export function renderTuiApproval(
    update: ToolApprovalUiRequestUpdate,
): string {
    const reason = specificReason(update.request.reason);
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
        ...visibleApprovalRows(update)
            .map((action) => `${action.key} ${approvalRowLabel(update, action)}`),
    ].join("\n");
}

function approvalRowLabel(
    update: ToolApprovalUiRequestUpdate,
    action: (typeof APPROVAL_ROWS)[number],
    inlineScope = true,
): string {
    if (action.key !== "2" || !inlineScope) {
        return action.label;
    }
    const scope = grantScope(update);
    return scope === undefined ? action.label : `${action.label} ${scope}`;
}

function grantScope(
    update: ToolApprovalUiRequestUpdate,
): string | undefined {
    const grants = update.request.permissionGrants;
    if (grants === undefined || grants.length !== 1) {
        return undefined;
    }
    return describeGrantPredicate(grants[0]!.when);
}

export function renderTuiApprovalDetails(
    update: ToolApprovalUiRequestUpdate,
    expanded = false,
): string {
    return tuiApprovalBodyText(update, expanded);
}

export function tuiApprovalDecision(
    key: TuiApprovalKey,
    grantsAvailable = true,
): TuiApprovalDecision | undefined {
    if (key.ctrl || key.meta || key.shift) {
        return undefined;
    }
    if (key.name === "1") {
        return "allow_once";
    }
    if (key.name === "2" && grantsAvailable) {
        return "allow_similar";
    }
    if (key.name === "3" || key.name === "escape") {
        return "deny";
    }
    if (key.name === "4" && grantsAvailable) {
        return "allow_always";
    }
    return undefined;
}

export function createTuiApprovalResponse(
    update: ToolApprovalUiRequestUpdate,
    key: TuiApprovalKey,
): UiResponseCommand | undefined {
    const decision = tuiApprovalDecision(
        key,
        update.request.permissionGrants !== undefined
            && update.request.sourceAgentId === undefined,
    );
    if (decision === undefined) {
        return undefined;
    }
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision },
    };
}

/** A deny that tells the agent what to do instead; undefined when the text is empty or a subagent asked, since notes never reach a subagent. */
export function createTuiApprovalNotesResponse(
    update: ToolApprovalUiRequestUpdate,
    text: string,
): UiResponseCommand | undefined {
    const notes = normalizeApprovalNotes(text);
    if (notes === undefined || update.request.sourceAgentId !== undefined) {
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

function isDerivedRow(key: string): boolean {
    return key === "2" || key === "4";
}

export function selectableApprovalKeys(
    update: ToolApprovalUiRequestUpdate,
): readonly string[] {
    return visibleApprovalRows(update)
        .filter((action) =>
            !isDerivedRow(action.key)
            || update.request.permissionGrants !== undefined
        )
        .map((action) => action.key);
}

export function tuiApprovalHint(
    update: ToolApprovalUiRequestUpdate,
): string {
    return update.request.sourceAgentId === undefined
        ? "approval required · 1 allow · 2 this chat · 3/esc deny · 5 tell Vera · Ctrl+C stop"
        : "approval required · 1 allow · 3/esc deny · Ctrl+C stop";
}

function visibleApprovalRows(
    update: ToolApprovalUiRequestUpdate,
): readonly (typeof APPROVAL_ROWS)[number][] {
    return update.request.sourceAgentId === undefined
        ? APPROVAL_ROWS
        : APPROVAL_ROWS.filter((action) =>
            !isDerivedRow(action.key) && action.key !== NOTES_KEY
        );
}

function specificReason(reason: string): string | undefined {
    return reason.startsWith("Permission mode ") ? undefined : reason;
}
