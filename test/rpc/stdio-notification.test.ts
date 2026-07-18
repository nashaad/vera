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
        "\nBackground agent child-1 completed:\nThe tests pass.\n",
    );
});
