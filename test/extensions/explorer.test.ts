import { expect, test } from "bun:test";
import {
    defaultHostExtensionConfigs,
    EXPLORER_EXTENSION_ID,
} from "../../src/extensions/bundled-host.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";

test("the bundled explorer registers a bounded definition and can be disabled", async () => {
    const configs = defaultHostExtensionConfigs([]);
    const registry = await startExtensionRegistry({ extensions: configs });
    try {
        const definition = registry.agents().find((entry) => entry.name === "explorer");
        expect(definition).toMatchObject({
            subagentAssignment: "eco",
            tools: ["read", "grep", "list"],
            skills: [],
            posture: "readonly",
        });
        expect(definition?.nudges).toBeUndefined();
        expect(defaultHostExtensionConfigs([EXPLORER_EXTENSION_ID])
            .map((config) => loadExtensionManifest(config.path).manifest.id))
            .not.toContain(EXPLORER_EXTENSION_ID);
    } finally {
        await registry.close();
    }
});
