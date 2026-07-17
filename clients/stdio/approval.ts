import type {
    UiRequestFrame,
    UiResponseFrame,
} from "../../src/engine/frames.ts";

export function renderStdioApproval(frame: UiRequestFrame): string {
    const command = frame.request.toolCall.input.command;
    const tool = frame.request.toolCall.name === "bash"
        && typeof command === "string"
        ? `$ ${command}`
        : `${frame.request.toolCall.name} ${JSON.stringify(frame.request.toolCall.input)}`;
    return [tool, frame.request.reason, frame.request.warning].join("\n");
}

export function createStdioApprovalResponse(
    frame: UiRequestFrame,
    answer: string | undefined,
): UiResponseFrame {
    const normalized = answer?.trim().toLowerCase();
    const decision = normalized === "y" || normalized === "yes"
        ? "allow"
        : "deny";
    return {
        type: "ui_response",
        requestId: frame.requestId,
        response: { type: "tool_approval", decision },
    };
}
