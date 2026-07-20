import {
    BoxRenderable,
    ScrollBoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    AgentUpdate,
    UiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";
import { TUI_NOTICE, TUI_TEXT } from "./state.ts";

const APPROVAL_ACTIONS = "[y] allow [n/esc] deny";

export type TuiApprovalDecision = "allow" | "deny";

export interface TuiApprovalKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    readonly details: ScrollBoxRenderable;
    readonly actions: TextRenderable;
    focus(): void;
    update(update: UiRequestUpdate): void;
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
        top: 0,
        bottom: 1,
        left: "5%",
        width: "90%",
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
            details.scrollTo(0);
        },
    };
}

export function renderTuiApproval(update: UiRequestUpdate): string {
    return [
        renderTuiApprovalDetails(update),
        "",
        APPROVAL_ACTIONS,
    ].join("\n");
}

export function renderTuiApprovalDetails(update: UiRequestUpdate): string {
    return [
        formatToolCall(update),
        "",
        update.request.reason,
        update.request.warning,
    ].join("\n");
}

export function tuiApprovalDecision(
    key: TuiApprovalKey,
): TuiApprovalDecision | undefined {
    if (key.ctrl || key.meta || key.shift) {
        return undefined;
    }
    if (key.name === "y") {
        return "allow";
    }
    if (key.name === "n" || key.name === "escape") {
        return "deny";
    }
    return undefined;
}

export function createTuiApprovalResponse(
    update: UiRequestUpdate,
    key: TuiApprovalKey,
): UiResponseCommand | undefined {
    const decision = tuiApprovalDecision(key);
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
    current: UiRequestUpdate | undefined,
    update: AgentUpdate,
): UiRequestUpdate | undefined {
    if (update.type === "ui_request") {
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

function formatToolCall(update: UiRequestUpdate): string {
    const command = update.request.toolCall.input.command;
    if (update.request.toolCall.name === "bash" && typeof command === "string") {
        return `$ ${command}`;
    }
    return `${update.request.toolCall.name} ${JSON.stringify(update.request.toolCall.input)}`;
}
