import { expect, test } from "bun:test";

import { renderStdioTaskNotification } from "../../clients/stdio/notification.ts";

test("stdio renders a task notification outside assistant text", () => {
    expect(renderStdioTaskNotification({
        type: "task_notification",
        deliveryId: "completion:child-1",
        sourceAgentId: "child-1",
        content: "The tests pass.",
        seq: 7,
    })).toBe(
        "\nAsync subagent child-1:\nThe tests pass.\n",
    );
});

test("stdio identifies an async subagent attention request", () => {
    expect(renderStdioTaskNotification({
        type: "task_notification",
        deliveryId: "attention:child-1:message-1",
        sourceAgentId: "child-1",
        content: "Which file?",
        kind: "attention",
        seq: 8,
    })).toBe(
        "\nAsync subagent child-1 needs attention:\nWhich file?\n",
    );
});
