import { expect, test } from "bun:test";

import { bundledClientExtensions } from "../../src/extensions/bundled-client.ts";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import {
    invokeDirectClientExtensionCommand,
    type DirectClientExtension,
} from "../../src/extensions/client.ts";

test("bundled help is an async direct client extension", async () => {
    const [extension] = bundledClientExtensions();

    expect(extension?.id).toBe("vera.help");
    expect(extension?.commands).toEqual([{
        name: "help",
        description: "Learn Vera controls and commands",
        usage: "/help",
        source: "vera.help",
    }]);
    expect(await extension?.invokeCommand("help", "")).toEqual({
        version: 1,
        source: "vera.help/help",
        body: {
            kind: "client_action",
            action: "show_help",
        },
    });
    await expect(extension?.invokeCommand("help", "extra"))
        .rejects.toThrow("Usage: /help");
    // The palette is a client surface bound to ctrl+p, not an extension command.
    await expect(extension?.invokeCommand("palette", ""))
        .rejects.toThrow("Usage: /palette");
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


test("reasoning cycle is a default included extension with no private tier", () => {
    const configured = includedExtensionConfigs([]).find(
        (config) =>
            loadExtensionManifest(config.path).manifest.id
                === "vera.reasoning-cycle",
    );

    expect(configured?.enabled).toBe(true);
    expect(includedExtensionConfigs(["vera.reasoning-cycle"]))
        .not.toContainEqual(configured);
});


test("Context is a default client-only package with its existing ID", () => {
    const configs = includedExtensionConfigs([]);
    const configured = configs.find((config) => loadExtensionManifest(config.path).manifest.id === "vera.context");
    expect(configured).toMatchObject({ enabled: true, config: {} });
    expect(configured?.path).toEndWith("/core-extensions/context");
    expect(includedExtensionConfigs(["vera.context"])).not.toContainEqual(configured);
});
