import type { TaskNotificationUpdate } from "../../src/engine/protocol.ts";

export function renderStdioTaskNotification(
    update: TaskNotificationUpdate,
): string {
    if (update.kind === "peer") {
        return `\nMessage from ${update.sourceAgentId}\n`;
    }
    const heading = update.kind === "attention"
        ? `Async subagent ${update.sourceAgentId} needs attention`
        : `Async subagent ${update.sourceAgentId}`;
    return `\n${heading}:\n${update.content}\n`;
}
