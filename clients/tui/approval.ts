import {
    BoxRenderable,
    fg,
    ScrollBoxRenderable,
    StyledText,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    AgentUpdate,
    ToolApprovalUiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import {
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";
import {
    describeGrantPredicate,
    tuiApprovalBody,
    tuiApprovalBodyText,
    type TuiApprovalTone,
} from "./approval-body.ts";
import {
    attachDialogRowPointer,
    DIALOG_SHORT_TERMINAL_HEIGHT,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

/**
 * The prompt takes the composer's slot at the bottom of the screen: a
 * notice-toned bar down the left edge, a "Permission required" header with the
 * reason, the exact call and its grant predicates in the body, and the answers
 * as a column. The answers keep their digits, so the keys that always answered
 * the prompt still do; ↑/↓ and ⏎ select the same answers by highlight.
 *
 * The answers stack. A row of them side by side was tried and read as a grid
 * the moment one label grew or the terminal narrowed, and it disagreed with the
 * question card, which stacks. Both cards stack, and the column leaves the
 * right of the panel free.
 */
const APPROVAL_ROWS = [
    { key: "1", label: "Allow once" },
    { key: "2", label: "Session" },
    { key: "3", label: "Deny" },
    { key: "4", label: "Always" },
] as const;

/**
 * Rows 2 and 4 derive the same predicate and differ only in where it is stored,
 * so they carry matching labels: a durable row that silenced a different set of
 * future prompts than the session row above it would be unpredictable from the
 * label alone.
 *
 * The durable row is `4` and deny stays on `3`, out of escalating order on
 * purpose. Renumbering deny would retrain an existing keypress toward the more
 * permissive direction, and a mis-hit there grants a permission that outlives
 * the session.
 */
export type TuiApprovalDecision =
    | "allow_once"
    | "allow_similar"
    | "allow_always"
    | "deny";

export interface TuiApprovalKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiApprovalKeyResult {
    readonly handled: boolean;
    readonly response?: UiResponseCommand;
}

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    // Buttons carry their own digit, so a click sends the digit the keyboard
    // would have sent rather than a second decision path.
    pointer?: DialogRowPointer;
    readonly bar: BoxRenderable;
    readonly headerText: TextRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
    focus(): void;
    update(update: ToolApprovalUiRequestUpdate): void;
    handleKey(
        update: ToolApprovalUiRequestUpdate,
        key: TuiApprovalKey,
    ): TuiApprovalKeyResult;
    repaint(): void;
}

export function createTuiApprovalView(
    renderer: RenderContext,
): TuiApprovalView {
    let currentRequestId: string | undefined;
    let lastUpdate: ToolApprovalUiRequestUpdate | undefined;
    // Highlighted answer for ↑/↓ and ⏎. Client-local: the engine only ever
    // sees the decision.
    let selectedKey: string = "1";
    // Whether the body is showing past its cap. Reset per request: an expanded
    // panel that stayed expanded would push the next call's answers down.
    let expanded = false;
    /** Whether the cap is holding anything back, which is what ctrl+r is for. */
    let capped = false;
    /** Whether the row is wide enough to carry the predicate it would remember. */
    let scopeInline = true;

    const bar = new BoxRenderable(renderer, {
        id: "approval-bar",
        width: 1,
        backgroundColor: TUI_NOTICE,
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
        flexGrow: 1,
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
        paddingTop: approvalTopPadding(renderer),
        paddingBottom: approvalBottomPadding(renderer),
        paddingLeft: 2,
        paddingRight: 2,
    });
    content.add(headerText);
    content.add(details);
    content.add(actions);

    const box = new BoxRenderable(renderer, {
        id: "approval-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: 1,
        left: approvalSideInset(renderer),
        right: 1,
        height: "auto",
        maxHeight: renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT
            ? "100%"
            : "90%",
        zIndex: 20,
        flexDirection: "row",
        visible: false,
    });
    box.add(bar);
    box.add(content);

    let buttonNodes: TextRenderable[] = [];

    function renderButtons(update: ToolApprovalUiRequestUpdate): void {
        for (const node of buttonNodes) {
            node.destroy();
        }
        buttonNodes = [];
        const available = selectableApprovalKeys(update);
        for (const action of visibleApprovalRows(update)) {
            const active = action.key === selectedKey;
            const node = new TextRenderable(renderer, {
                content: new StyledText([
                    fg(active ? TUI_BACKGROUND : TUI_MUTED)(
                        approvalRowText(update, action, scopeInline),
                    ),
                ]),
                bg: active ? TUI_NOTICE : TUI_PANEL,
                attributes: active ? 1 : 0,
                width: "100%",
                height: 1,
                flexShrink: 0,
                wrapMode: "none",
                overflow: "hidden",
            });
            if (available.includes(action.key)) {
                attachDialogRowPointer(node, view.pointer, Number(action.key));
            }
            buttons.add(node);
            buttonNodes.push(node);
        }
    }

    function renderBody(update: ToolApprovalUiRequestUpdate): void {
        const body = tuiApprovalBody(update, expanded, scopeInline);
        capped = expanded || body.hidden > 0;
        detailsText.content = new StyledText(
            body.lines.flatMap((line, index) => [
                fg(toneColor(line.tone))(line.text),
                ...(index === body.lines.length - 1 ? [] : [fg(TUI_TEXT)("\n")]),
            ]),
        );
    }

    function renderChrome(update: ToolApprovalUiRequestUpdate): void {
        bar.backgroundColor = TUI_NOTICE;
        box.backgroundColor = TUI_PANEL;
        detailsText.fg = TUI_TEXT;
        const reason = specificReason(update.request.reason);
        headerText.content = new StyledText([
            fg(TUI_NOTICE)("Permission required"),
            fg(TUI_MUTED)(`  ${update.request.toolCall.name}`),
            ...(reason === undefined ? [] : [fg(TUI_MUTED)(`\n${reason}`)]),
        ]);
        hints.content = new StyledText([
            fg(TUI_TEXT)("up/down"),
            fg(TUI_MUTED)(" select  "),
            fg(TUI_TEXT)("enter"),
            fg(TUI_MUTED)(" confirm  "),
            fg(TUI_TEXT)("esc"),
            fg(TUI_MUTED)(" deny"),
            ...(capped
                ? [
                    fg(TUI_TEXT)("  ctrl+r"),
                    fg(TUI_MUTED)(expanded ? " collapse" : " expand"),
                ]
                : []),
        ]);
        // Narrow terminals give the hints' columns to the buttons: the keys
        // still work unlabelled, an answer pushed off the screen does not.
        hints.visible = renderer.width >= 60;
        renderButtons(update);
    }

    const view: TuiApprovalView = {
        box,
        bar,
        headerText,
        details,
        detailsText,
        actions,
        focus(): void {
            details.focus();
        },
        update(update): void {
            lastUpdate = update;
            box.maxHeight = renderer.height <= DIALOG_SHORT_TERMINAL_HEIGHT
                ? "100%"
                : "90%";
            box.left = approvalSideInset(renderer);
            const inline = scopeFitsRow(renderer, update);
            bar.visible = approvalChromeVisible(renderer);
            headerText.visible = approvalHeaderVisible(renderer);
            content.paddingTop = approvalTopPadding(renderer);
            content.paddingBottom = approvalBottomPadding(renderer);
            details.marginTop = approvalDetailsMargin(renderer);
            hints.visible = renderer.width >= 60;
            if (currentRequestId === update.requestId) {
                // A resize can take the predicate off the row or give it back.
                if (inline !== scopeInline) {
                    scopeInline = inline;
                    renderBody(update);
                    renderChrome(update);
                }
                return;
            }
            currentRequestId = update.requestId;
            scopeInline = inline;
            selectedKey = "1";
            expanded = false;
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
            if (key.ctrl || key.meta || key.shift) {
                return { handled: false };
            }
            if (key.name === "up" || key.name === "down") {
                const keys = selectableApprovalKeys(update);
                const index = Math.max(0, keys.indexOf(selectedKey));
                const next = key.name === "up"
                    ? Math.max(0, index - 1)
                    : Math.min(keys.length - 1, index + 1);
                if (keys[next] !== undefined && keys[next] !== selectedKey) {
                    selectedKey = keys[next];
                    renderButtons(update);
                }
                return { handled: true };
            }
            if (key.name === "return" || key.name === "enter") {
                const response = createTuiApprovalResponse(update, {
                    name: selectedKey,
                });
                return response === undefined
                    ? { handled: true }
                    : { handled: true, response };
            }
            const response = createTuiApprovalResponse(update, key);
            return response === undefined
                ? { handled: false }
                : { handled: true, response };
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

function approvalBottomPadding(renderer: RenderContext): number {
    return approvalChromeVisible(renderer) ? 1 : 0;
}

function approvalTopPadding(renderer: RenderContext): number {
    return approvalHeaderVisible(renderer) ? 1 : 0;
}

function approvalDetailsMargin(renderer: RenderContext): number {
    return approvalHeaderVisible(renderer) ? 1 : 0;
}

function approvalHeaderVisible(renderer: RenderContext): boolean {
    return renderer.height > 6;
}

function approvalChromeVisible(renderer: RenderContext): boolean {
    return renderer.height > DIALOG_SHORT_TERMINAL_HEIGHT;
}

function approvalSideInset(renderer: RenderContext): number {
    return approvalChromeVisible(renderer) ? 2 : 0;
}

/**
 * Whether the remembering row can carry its predicate. An answer that outruns
 * its row is clipped, and a clipped path claims a scope narrower than what
 * would be stored, so the label gives it up and the body states it instead.
 */
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
        - approvalSideInset(renderer)
        - 1
        - chrome
        - padding;
    return approvalRowText(update, row, true).length <= available;
}

/** A button's own cell: its digit, its label, and the padding around them. */
function approvalRowText(
    update: ToolApprovalUiRequestUpdate,
    action: (typeof APPROVAL_ROWS)[number],
    inlineScope: boolean,
): string {
    return ` ${action.key} ${approvalRowLabel(update, action, inlineScope)} `;
}

export function renderTuiApproval(update: ToolApprovalUiRequestUpdate): string {
    const reason = specificReason(update.request.reason);
    return [
        `Permission required · ${update.request.toolCall.name}`,
        ...(reason === undefined ? [] : [reason]),
        "",
        renderTuiApprovalDetails(update),
        "",
        ...visibleApprovalRows(update)
            .map((action) => `${action.key} ${approvalRowLabel(update, action)}`),
    ].join("\n");
}

/**
 * What "Session" and "Always" would remember, on the row that offers them.
 * Stating it twice, once as a label and once as a body block, said the same
 * thing in two registers.
 */
function approvalRowLabel(
    update: ToolApprovalUiRequestUpdate,
    action: (typeof APPROVAL_ROWS)[number],
    inlineScope = true,
): string {
    // Both remembering rows share the predicate, so it is written once, on the
    // first one that offers it.
    if (action.key !== "2" || !inlineScope) {
        return action.label;
    }
    const scope = grantScope(update);
    return scope === undefined ? action.label : `${action.label} ${scope}`;
}

/**
 * The predicate as a label, only when one label can say the whole of it. Every
 * proposal is stored on the decision, so a set the label cannot hold goes to
 * the body instead of being summarized by its first member.
 */
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
    if (tone === "add") return TUI_SUCCESS;
    if (tone === "del") return TUI_NOTICE;
    if (tone === "muted" || tone === "path") return TUI_MUTED;
    return TUI_TEXT;
}

/** Rows whose meaning comes from the derived grant predicate, not the tool. */
function isDerivedRow(key: string): boolean {
    return key === "2" || key === "4";
}

/** The digits ←/→ and a click can land on: derived rows need a predicate. */
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
        ? "approval required · 1 once · 2 session prefix · 3/esc deny · ctrl+c stop"
        : "approval required · 1 once · 3/esc deny · ctrl+c stop";
}

function visibleApprovalRows(
    update: ToolApprovalUiRequestUpdate,
): readonly (typeof APPROVAL_ROWS)[number][] {
    return update.request.sourceAgentId === undefined
        ? APPROVAL_ROWS
        : APPROVAL_ROWS.filter((action) => !isDerivedRow(action.key));
}

/**
 * The reason, when it says something the header does not. The mode-derived
 * form only restates that approval is required, which is what the header is.
 */
function specificReason(reason: string): string | undefined {
    return reason.startsWith("Permission mode ") ? undefined : reason;
}
