import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../src/config.ts";

test("Vera config loads the shared model choice", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "  anthropic/example-model  ",
    }));

    expect(loadVeraConfig({ path })).toEqual({
        schema_version: 1,
        model: "anthropic/example-model",
    });
});

test("Vera config rejects a missing model", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({ schema_version: 1 }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "expected schema_version 1 and a non-empty model string",
    );
});

test("Vera config reports its missing path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-config-")), "missing.json");

    expect(() => loadVeraConfig({ path })).toThrow(
        `Vera config not found at ${path}`,
    );
});

function temporaryConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-config-")), "config.json");
}
