import type {
    AgentUpdate,
    UiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";

export type TuiApprovalDecision = "allow" | "deny";

export interface TuiApprovalKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export function renderTuiApproval(update: UiRequestUpdate): string {
    return [
        formatToolCall(update),
        "",
        update.request.reason,
        update.request.warning,
        "",
        "[y] allow    [n/esc] deny",
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
