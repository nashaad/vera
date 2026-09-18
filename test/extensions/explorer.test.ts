import { expect, test } from "bun:test";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";

test("the included explorer registers a bounded definition and can be disabled", async () => {
    const configs = includedExtensionConfigs([]);
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
        expect(includedExtensionConfigs(["vera.explorer"])
            .map((config) => loadExtensionManifest(config.path).manifest.id))
            .not.toContain("vera.explorer");
    } finally {
        await registry.close();
    }
});
