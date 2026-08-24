import { expect, test } from "bun:test";

import {
    ADVERSARIAL_EXTENSION_ID,
    bundledHostExtensionConfigs,
} from "../../src/extensions/bundled-host.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";

test("adversarial review is a disableable bundled host extension", () => {
    const [config] = bundledHostExtensionConfigs();
    expect(config?.enabled).toBeTrue();
    expect(loadExtensionManifest(config!.path).manifest.id)
        .toBe(ADVERSARIAL_EXTENSION_ID);
    expect(bundledHostExtensionConfigs([ADVERSARIAL_EXTENSION_ID])).toEqual([]);
});

test("the bundled manifest publishes one command and one top-level tool", async () => {
    const registry = await startExtensionRegistry({
        extensions: bundledHostExtensionConfigs(),
    });
    try {
        expect(registry.commands()).toEqual([
            expect.objectContaining({ name: "adversarial" }),
        ]);
        expect(registry.tools()).toEqual([
            expect.objectContaining({
                invocation: "top_level",
                permissionOperation: "adversarial.review",
                definition: expect.objectContaining({
                    name: "adversarial_review",
                }),
            }),
        ]);
    } finally {
        await registry.close();
    }
});
