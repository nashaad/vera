import type { TaskNotificationUpdate } from "../../src/engine/protocol.ts";

export function renderStdioTaskNotification(
    update: TaskNotificationUpdate,
): string {
    const heading = update.kind === "attention"
        ? `Async subagent ${update.sourceAgentId} needs attention`
        : `Async subagent ${update.sourceAgentId}`;
    return `\n${heading}:\n${update.content}\n`;
}
