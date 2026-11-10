import { expect, test } from "bun:test";

test("@core compiled client extensions resolve exports from the on-disk runtime", async () => {
    const source = await Bun.file("src/extensions/client-registry.ts").text();
    const loader = source.split("async function importFreshClientExtension(")[1]?.split("\nfunction ")[0];
    expect(loader).toBeDefined();
    expect(loader).toContain('join(dirname(process.execPath), "node_modules", "@opentui", "core", "index.js")');
    expect(loader).toContain("await import(tuiModule)");
    expect(loader).toContain("JSON.stringify(tuiModule)");
});
