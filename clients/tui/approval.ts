import {
    BoxRenderable,
    ScrollBoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    AgentUpdate,
    ToolApprovalUiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { TUI_NOTICE, TUI_TEXT } from "./state.ts";

const APPROVAL_ACTIONS = "[1]once [2]prefix [3/esc]deny";
const APPROVAL_ACTIONS_WITHOUT_PREFIX =
    "[1]once [2]n/a [3/esc]deny";

export type TuiApprovalDecision = "allow_once" | "allow_prefix" | "deny";

export interface TuiApprovalKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: TextRenderable;
    focus(): void;
    update(update: ToolApprovalUiRequestUpdate): void;
}

export function createTuiApprovalView(
    renderer: RenderContext,
): TuiApprovalView {
    let currentRequestId: string | undefined;
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
        scrollY: true,
        scrollX: false,
        viewportCulling: true,
        contentOptions: {
            flexDirection: "column",
        },
    });
    details.add(detailsText);

    const actions = new TextRenderable(renderer, {
        id: "approval-actions",
        content: APPROVAL_ACTIONS,
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        maxHeight: 2,
        wrapMode: "word",
        flexShrink: 0,
    });

    const box = new BoxRenderable(renderer, {
        id: "approval-box",
        title: " Tool approval ",
        border: true,
        borderColor: TUI_NOTICE,
        backgroundColor: "#16161E",
        position: "absolute",
        bottom: 1,
        left: "5%",
        width: "90%",
        height: "auto",
        maxHeight: "90%",
        zIndex: 20,
        flexDirection: "column",
        gap: 0,
        paddingX: 1,
        visible: false,
    });
    box.add(details);
    box.add(actions);

    return {
        box,
        details,
        detailsText,
        actions,
        focus(): void {
            details.focus();
        },
        update(update): void {
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            detailsText.content = renderTuiApprovalDetails(update);
            actions.content = approvalActions(update);
            details.scrollTo(0);
        },
    };
}

export function renderTuiApproval(update: ToolApprovalUiRequestUpdate): string {
    return [
        renderTuiApprovalDetails(update),
        "",
        approvalActions(update),
    ].join("\n");
}

export function renderTuiApprovalDetails(
    update: ToolApprovalUiRequestUpdate,
): string {
    const prefix = update.request.commandPrefix;
    return [
        formatToolCall(update),
        "",
        update.request.reason,
        update.request.warning,
        ...(prefix === undefined
            ? []
            : ["", `Session prefix: $ ${formatPrefix(prefix.tokens)}`]),
    ].join("\n");
}

export function tuiApprovalDecision(
    key: TuiApprovalKey,
    prefixAvailable = true,
): TuiApprovalDecision | undefined {
    if (key.ctrl || key.meta || key.shift) {
        return undefined;
    }
    if (key.name === "1") {
        return "allow_once";
    }
    if (key.name === "2" && prefixAvailable) {
        return "allow_prefix";
    }
    if (key.name === "3" || key.name === "escape") {
        return "deny";
    }
    return undefined;
}

export function createTuiApprovalResponse(
    update: ToolApprovalUiRequestUpdate,
    key: TuiApprovalKey,
): UiResponseCommand | undefined {
    const decision = tuiApprovalDecision(
        key,
        update.request.commandPrefix !== undefined,
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

function formatToolCall(update: ToolApprovalUiRequestUpdate): string {
    const command = update.request.toolCall.input.command;
    if (update.request.toolCall.name === "bash" && typeof command === "string") {
        return `$ ${command}`;
    }
    return `${update.request.toolCall.name} ${JSON.stringify(update.request.toolCall.input)}`;
}

function approvalActions(update: ToolApprovalUiRequestUpdate): string {
    return update.request.commandPrefix === undefined
        ? APPROVAL_ACTIONS_WITHOUT_PREFIX
        : APPROVAL_ACTIONS;
}

function formatPrefix(tokens: readonly string[]): string {
    return tokens.map(formatShellToken).join(" ");
}

function formatShellToken(token: string): string {
    return /^[A-Za-z0-9_./:@%+=,-]+$/.test(token)
        ? token
        : `'${token.replaceAll("'", `'\\''`)}'`;
}
