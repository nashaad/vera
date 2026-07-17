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
        provider: "openrouter",
        model: "anthropic/example-model",
        approval_mode: "approve_for_me",
    });
});

test("Vera config selects OpenAI Codex", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "off",
    }));

    expect(loadVeraConfig({ path })).toEqual({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "off",
        approval_mode: "approve_for_me",
    });
});

test("Vera config loads each approval mode", () => {
    for (const approval_mode of ["ask", "approve_for_me", "full_access"] as const) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            approval_mode,
        }));

        expect(loadVeraConfig({ path }).approval_mode).toBe(approval_mode);
    }
});

test("Vera config rejects a missing model", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({ schema_version: 1 }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "expected schema_version 1, provider openrouter or openai-codex, a non-empty model string",
    );
});

test("Vera config rejects an unknown reasoning effort", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        reasoning_effort: "maximum",
    }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "optional reasoning_effort off, low, medium, high, or max",
    );
});

test("Vera config rejects an unknown approval mode", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "sometimes",
    }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "optional approval_mode ask, approve_for_me, or full_access",
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
