import { expect, test } from "bun:test";

import { bundledClientExtensions } from "../../src/extensions/bundled-client.ts";
import {
    invokeDirectClientExtensionCommand,
    type DirectClientExtension,
} from "../../src/extensions/client.ts";

test("bundled help is an async direct client extension", async () => {
    const [extension] = bundledClientExtensions();

    expect(extension?.id).toBe("vera.help");
    expect(extension?.commands).toEqual([{
        name: "help",
        description: "Browse available commands",
        usage: "/help",
        source: "vera.help",
    }]);
    expect(await extension?.invokeCommand("help", "")).toEqual({
        version: 1,
        source: "vera.help/help",
        body: {
            kind: "client_action",
            action: "show_commands",
        },
    });
    await expect(extension?.invokeCommand("help", "extra"))
        .rejects.toThrow("Usage: /help");
});

test("direct client extension calls have a fixed deadline", async () => {
    const hanging: DirectClientExtension = {
        id: "test.hanging",
        commands: [],
        invokeCommand: () => new Promise(() => undefined),
    };

    await expect(invokeDirectClientExtensionCommand(
        hanging,
        "hang",
        "",
        { timeoutMs: 10 },
    )).rejects.toThrow("timed out after 10ms");
});
