import type {
    ToolApprovalUiRequestUpdate,
    UiResponseCommand,
} from "../../src/engine/protocol.ts";

export function renderStdioApproval(
    update: ToolApprovalUiRequestUpdate,
): string {
    const command = update.request.toolCall.input.command;
    const tool = update.request.toolCall.name === "bash"
        && typeof command === "string"
        ? `$ ${command}`
        : `${update.request.toolCall.name} ${JSON.stringify(update.request.toolCall.input)}`;
    const prefix = update.request.commandPrefix;
    return [
        tool,
        update.request.reason,
        update.request.warning,
        ...(prefix === undefined
            ? []
            : [`Session prefix: ${JSON.stringify(prefix.tokens)}`]),
    ].join("\n");
}

export function createStdioApprovalResponse(
    update: ToolApprovalUiRequestUpdate,
    answer: string | undefined,
): UiResponseCommand {
    const normalized = answer?.trim();
    const decision = normalized === "1"
        ? "allow_once"
        : normalized === "2" && update.request.commandPrefix !== undefined
            ? "allow_prefix"
            : "deny";
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision },
    };
}
