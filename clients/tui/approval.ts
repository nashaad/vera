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
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import {
    TUI_BACKGROUND,
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
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
    attachDialogRowPointer,
    DIALOG_CARD_Z_INDEX,
    DIALOG_SHORT_TERMINAL_HEIGHT,
    type DialogRowPointer,
} from "./dialog-chrome.ts";

const APPROVAL_ROWS = [
    { key: "1", label: "Allow once" },
    { key: "2", label: "Session" },
    { key: "3", label: "Deny" },
    { key: "4", label: "Always" },
] as const;

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
    let selectedKey: string = "1";
    let expanded = false;
    let capped = false;
    let scopeInline = true;

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

    let buttonNodes: TextRenderable[] = [];

    function renderButtons(update: ToolApprovalUiRequestUpdate): void {
        for (const node of buttonNodes) {
            node.destroyRecursively();
        }
        buttonNodes = [];
        const available = selectableApprovalKeys(update);
        for (const action of visibleApprovalRows(update)) {
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
            if (selectable) {
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
        headerText.content = new StyledText([
            fg(TUI_NOTICE)("Permission required"),
            fg(TUI_MUTED)(`  ${update.request.toolCall.name}`),
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
                    fg(TUI_TEXT)("  Ctrl+R"),
                    fg(TUI_MUTED)(expanded ? " collapse" : " expand"),
                ]
                : []),
        ]);
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
            const inline = scopeFitsRow(renderer, update);
            bar.visible = approvalChromeVisible(renderer);
            header.visible = approvalHeaderVisible(renderer);
            content.paddingTop = 0;
            content.paddingBottom = approvalBottomPadding(renderer);
            details.marginTop = 0;
            hints.visible = renderer.width >= 60;
            if (currentRequestId === update.requestId) {
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

function approvalHeaderVisible(renderer: RenderContext): boolean {
    return renderer.height > 6;
}

function approvalChromeVisible(renderer: RenderContext): boolean {
    return renderer.height > DIALOG_SHORT_TERMINAL_HEIGHT;
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
        ? "approval required · 1 once · 2 session prefix · 3/esc deny · Ctrl+C stop"
        : "approval required · 1 once · 3/esc deny · Ctrl+C stop";
}

function visibleApprovalRows(
    update: ToolApprovalUiRequestUpdate,
): readonly (typeof APPROVAL_ROWS)[number][] {
    return update.request.sourceAgentId === undefined
        ? APPROVAL_ROWS
        : APPROVAL_ROWS.filter((action) => !isDerivedRow(action.key));
}

function specificReason(reason: string): string | undefined {
    return reason.startsWith("Permission mode ") ? undefined : reason;
}
