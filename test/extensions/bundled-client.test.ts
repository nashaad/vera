import { expect, test } from "bun:test";

import {
    bundledClientExtensionConfigs,
    bundledClientExtensions,
} from "../../src/extensions/bundled-client.ts";
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

test("quickslots are a default bundled extension with no private tier", () => {
    const [configured] = bundledClientExtensionConfigs([]);

    expect(configured?.enabled).toBe(true);
    expect(loadExtensionManifest(configured!.path).manifest.id)
        .toBe("vera.model-presets");
    expect(
        bundledClientExtensionConfigs(["vera.model-presets"]).map(
            (config) => loadExtensionManifest(config.path).manifest.id,
        ),
    ).toEqual(["vera.reasoning-cycle"]);
});

test("reasoning cycle is a default bundled extension with no private tier", () => {
    const configured = bundledClientExtensionConfigs([]).find(
        (config) =>
            loadExtensionManifest(config.path).manifest.id
                === "vera.reasoning-cycle",
    );

    expect(configured?.enabled).toBe(true);
    expect(bundledClientExtensionConfigs(["vera.reasoning-cycle"]).map(
        (config) => loadExtensionManifest(config.path).manifest.id,
    )).toEqual(["vera.model-presets"]);
});
