import { describe, expect, test } from "bun:test";

import { createInProcessChannel } from "../../src/rpc/in-process-channel.ts";
import type { AgentFrame, ClientFrame } from "../../src/rpc/frames.ts";

describe("in-process channel", () => {
    test("passes frames in both directions", async () => {
        const channel = createInProcessChannel();
        const prompt: ClientFrame = {
            type: "prompt",
            content: "say hi",
        };
        const status: AgentFrame = {
            type: "status",
            state: "working",
            seq: 1,
        };

        channel.client.send(prompt);
        expect(await channel.engine.receive()).toEqual(prompt);

        channel.engine.send(status);
        expect(await channel.client.receive()).toEqual(status);
    });
});
