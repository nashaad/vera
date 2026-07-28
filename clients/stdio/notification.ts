import type { TaskNotificationUpdate } from "../../src/engine/protocol.ts";

export function renderStdioTaskNotification(
    update: TaskNotificationUpdate,
): string {
    return `\nAsync subagent ${update.sourceAgentId}:\n${update.content}\n`;
}
