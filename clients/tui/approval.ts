import type {
    AgentFrame,
    UiRequestFrame,
    UiResponseFrame,
} from "../../src/engine/frames.ts";

export type TuiApprovalDecision = "allow" | "deny";

export interface TuiApprovalKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export function renderTuiApproval(frame: UiRequestFrame): string {
    return [
        formatToolCall(frame),
        "",
        frame.request.reason,
        frame.request.warning,
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
    frame: UiRequestFrame,
    key: TuiApprovalKey,
): UiResponseFrame | undefined {
    const decision = tuiApprovalDecision(key);
    if (decision === undefined) {
        return undefined;
    }
    return {
        type: "ui_response",
        requestId: frame.requestId,
        response: { type: "tool_approval", decision },
    };
}

export function applyTuiApprovalFrame(
    current: UiRequestFrame | undefined,
    frame: AgentFrame,
): UiRequestFrame | undefined {
    if (frame.type === "ui_request") {
        return frame;
    }
    if (
        frame.type === "ui_request_closed"
        && current?.requestId === frame.requestId
    ) {
        return undefined;
    }
    return current;
}

function formatToolCall(frame: UiRequestFrame): string {
    const command = frame.request.toolCall.input.command;
    if (frame.request.toolCall.name === "bash" && typeof command === "string") {
        return `$ ${command}`;
    }
    return `${frame.request.toolCall.name} ${JSON.stringify(frame.request.toolCall.input)}`;
}
