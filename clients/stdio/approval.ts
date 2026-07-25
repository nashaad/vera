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
    const grants = update.request.permissionGrants;
    return [
        tool,
        update.request.reason,
        update.request.warning,
        ...(grants === undefined
            ? []
            : [`Session grants: ${JSON.stringify(grants)}`]),
    ].join("\n");
}

export function createStdioApprovalResponse(
    update: ToolApprovalUiRequestUpdate,
    answer: string | undefined,
): UiResponseCommand {
    const normalized = answer?.trim();
    const grantsAvailable = update.request.permissionGrants !== undefined;
    // Anything unrecognized falls through to deny, so a stray keystroke can
    // never persist a permission.
    const decision = normalized === "1"
        ? "allow_once"
        : normalized === "2" && grantsAvailable
            ? "allow_similar"
            : normalized === "4" && grantsAvailable
                ? "allow_always"
                : "deny";
    return {
        type: "ui_response",
        requestId: update.requestId,
        response: { type: "tool_approval", decision },
    };
}
