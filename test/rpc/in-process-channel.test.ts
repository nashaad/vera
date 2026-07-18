import { describe, expect, test } from "bun:test";

import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";

describe("in-process channel", () => {
    test("passes commands and updates in both directions", async () => {
        const channel = createInProcessChannel();
        const prompt: ClientCommand = {
            type: "prompt",
            content: "say hi",
        };
        const status: AgentUpdate = {
            type: "status",
            state: "working",
            seq: 1,
        };

        channel.client.send(prompt);
        expect(await channel.engine.receive()).toEqual(prompt);

        channel.engine.send(status);
        expect(await channel.client.receive()).toEqual(status);

        const notification: AgentUpdate = {
            type: "task_notification",
            deliveryId: "completion:child-1",
            sourceAgentId: "child-1",
            content: "The tests pass.",
            seq: 2,
        };
        channel.engine.send(notification);
        expect(await channel.client.receive()).toEqual(notification);
    });
});
