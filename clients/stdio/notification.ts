import type { TaskNotificationUpdate } from "../../src/engine/protocol.ts";

export function renderStdioTaskNotification(
    update: TaskNotificationUpdate,
): string {
    return `\nBackground agent ${update.sourceAgentId} completed:\n${update.content}\n`;
}
