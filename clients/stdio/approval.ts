import type {
    UiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";

export function renderStdioApproval(update: UiRequestUpdate): string {
    const command = update.request.toolCall.input.command;
    const tool = update.request.toolCall.name === "bash"
        && typeof command === "string"
        ? `$ ${command}`
        : `${update.request.toolCall.name} ${JSON.stringify(update.request.toolCall.input)}`;
    return [tool, update.request.reason, update.request.warning].join("\n");
}

export function createStdioApprovalResponse(
    update: UiRequestUpdate,
    answer: string | undefined,
): UiResponseCommand {
    const normalized = answer?.trim().toLowerCase();
    const decision = normalized === "y" || normalized === "yes"
        ? "allow"
        : "deny";
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision },
    };
}
