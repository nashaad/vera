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
import { TUI_PANEL, TUI_TEXT } from "./state.ts";
import {
    dialogBottomOffset,
    dialogHeaderNode,
    dialogOptionRow,
} from "./dialog-chrome.ts";

/**
 * The approval choices are rendered as numbered rows rather than one muted
 * hint line, because against a tall block of command detail a single grey line
 * reads as chrome and the user misses that it is the thing to act on. This
 * mirrors the question overlay, which already does it this way.
 */
const APPROVAL_ROWS = [
    { key: "1", label: "Allow once" },
    { key: "2", label: "Allow similar this session" },
    { key: "3", label: "Deny", meta: "esc" },
    { key: "4", label: "Allow similar always" },
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

export interface TuiApprovalView {
    readonly box: BoxRenderable;
    readonly details: ScrollBoxRenderable;
    readonly detailsText: TextRenderable;
    readonly actions: BoxRenderable;
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

    const actions = new BoxRenderable(renderer, {
        id: "approval-actions",
        width: "100%",
        height: "auto",
        flexShrink: 0,
        flexDirection: "column",
    });
    let actionRows: BoxRenderable[] = [];

    function renderActions(update: ToolApprovalUiRequestUpdate): void {
        for (const row of actionRows) {
            row.destroy();
        }
        actionRows = [];
        const grants = update.request.permissionGrants;
        for (const action of APPROVAL_ROWS) {
            // Keep the row in place when no honest reusable grant can be
            // derived so the approval key numbering stays stable.
            const derived = isDerivedRow(action.key);
            const unavailable = derived && grants === undefined;
            const row = dialogOptionRow(renderer, {
                label: action.label,
                leading: `${action.key}  `,
                active: false,
                ...("meta" in action ? { meta: action.meta } : {}),
                ...(unavailable
                    ? { description: "not available for this command" }
                    : derived
                    ? { description: formatGrants(grants!) }
                    : {}),
            });
            actions.add(row);
            actionRows.push(row);
        }
    }

    const header = dialogHeaderNode(renderer, "Tool approval");
    // Kept tight (no vertical padding, single row gap) so the prompt still fits
    // very short terminals where the card padding would push the actions off.
    const box = new BoxRenderable(renderer, {
        id: "approval-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: dialogBottomOffset(renderer),
        left: "5%",
        width: "90%",
        height: "auto",
        maxHeight: "90%",
        zIndex: 20,
        flexDirection: "column",
        gap: 0,
        paddingLeft: 2,
        paddingRight: 2,
        visible: false,
    });
    box.add(header);
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
            box.bottom = dialogBottomOffset(renderer);
            if (currentRequestId === update.requestId) {
                return;
            }
            currentRequestId = update.requestId;
            detailsText.content = renderTuiApprovalDetails(update);
            renderActions(update);
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
    const grants = update.request.permissionGrants;
    return [
        formatToolCall(update),
        "",
        update.request.reason,
        update.request.warning,
        ...(grants === undefined
            ? []
            : ["", `Session grants: ${formatGrants(grants)}`]),
    ].join("\n");
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
        update.request.permissionGrants !== undefined,
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

/** Rows whose meaning comes from the derived grant predicate, not the tool. */
function isDerivedRow(key: string): boolean {
    return key === "2" || key === "4";
}

function formatToolCall(update: ToolApprovalUiRequestUpdate): string {
    const command = update.request.toolCall.input.command;
    if (update.request.toolCall.name === "bash" && typeof command === "string") {
        return `$ ${command}`;
    }
    return `${update.request.toolCall.name} ${JSON.stringify(update.request.toolCall.input)}`;
}

function approvalActions(update: ToolApprovalUiRequestUpdate): string {
    const grants = update.request.permissionGrants;
    return [
        ...APPROVAL_ROWS.map((action) => {
            if (!isDerivedRow(action.key)) {
                return "meta" in action
                    ? `${action.key}  ${action.label}  ${action.meta}`
                    : `${action.key}  ${action.label}`;
            }
            return grants === undefined
                ? `${action.key}  ${action.label}  not available for this command`
                : `${action.key}  ${action.label}  ${formatGrants(grants)}`;
        }),
    ].join("\n");
}

function formatGrants(
    grants: NonNullable<ToolApprovalUiRequestUpdate["request"]["permissionGrants"]>,
): string {
    return grants.map((grant) => {
        const fields = Object.entries(grant.when)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(", ");
        return `${grant.kind}: ${fields}`;
    }).join("; ");
}
