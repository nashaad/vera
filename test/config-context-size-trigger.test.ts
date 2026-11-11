import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig, VeraConfigError } from "../src/config.ts";

function configPath(hooks: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "vera-config-trigger-hook-")), "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        hooks,
    }));
    return path;
}

test("the context size trigger phase is accepted for the Vera protocol", () => {
    const path = configPath([
        { phase: "context_size_trigger", argv: ["lookout.ts"] },
    ]);
    expect(loadVeraConfig({ path }).hooks?.map((hook) => hook.phase))
        .toEqual(["context_size_trigger"]);
});

test("the context size trigger phase has no claude protocol event", () => {
    const path = configPath([
        { phase: "context_size_trigger", argv: ["lookout.ts"], protocol: "claude" },
    ]);
    expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
});
