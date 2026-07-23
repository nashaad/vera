import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    configuredModelFallback,
    loadVeraConfig,
    updateVeraConfigDefaults,
} from "../src/config.ts";

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
        approval_mode: "auto",
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
        approval_mode: "auto",
    });
});

test("Vera config selects Ollama without an API key", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "ollama",
        model: "gemma4:26b",
        reasoning_effort: "off",
    }));

    expect(loadVeraConfig({ path })).toEqual({
        schema_version: 1,
        provider: "ollama",
        model: "gemma4:26b",
        reasoning_effort: "off",
        approval_mode: "auto",
    });
});

test("Vera config loads each approval mode", () => {
    for (const approval_mode of ["ask", "auto", "full_access"] as const) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            approval_mode,
        }));

        expect(loadVeraConfig({ path }).approval_mode).toBe(approval_mode);
    }
});

test("Vera config migrates the former automatic mode name", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        approval_mode: "approve_for_me",
    }));

    expect(loadVeraConfig({ path }).approval_mode).toBe("auto");
});

test("Vera config loads an engine model fallback", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        model: "primary/model",
        fallback: {
            model: "  backup/model  ",
            after_failures: 2,
        },
    }));

    const config = loadVeraConfig({ path });
    expect(config.fallback).toEqual({
        model: "backup/model",
        after_failures: 2,
    });
    expect(configuredModelFallback(config)).toEqual({
        provider: "openrouter",
        model: "backup/model",
        afterFailures: 2,
    });
});

test("Vera config rejects an unreachable or circular fallback", () => {
    for (const fallback of [
        { model: "primary/model", after_failures: 2 },
        { model: "backup/model", after_failures: 4 },
        { model: "backup/model", after_failures: 1.5 },
    ]) {
        const path = temporaryConfigPath();
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "primary/model",
            fallback,
        }));

        expect(() => loadVeraConfig({ path })).toThrow(
            "optional fallback with a different model and after_failures from 1 to 3",
        );
    }
});

test("OpenAI Codex fallback rejects an unmappable reasoning effort", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
        fallback: {
            model: "different-backup",
            after_failures: 2,
        },
    }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "OpenAI Codex fallback requires reasoning_effort to be omitted",
    );
});

test("Vera config rejects a missing model", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({ schema_version: 1 }));

    expect(() => loadVeraConfig({ path })).toThrow(
        "expected schema_version 1, provider openrouter, openai-codex, or ollama, a non-empty model string",
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
        "optional approval_mode ask, auto, or full_access",
    );
});

test("Vera config reports its missing path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-config-")), "missing.json");

    expect(() => loadVeraConfig({ path })).toThrow(
        `Vera config not found at ${path}`,
    );
});

test("settings changes become defaults for newly created chats", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoning_effort: "max",
        approval_mode: "auto",
    }));

    expect(updateVeraConfigDefaults({
        model: "z-ai/glm-5.2",
        reasoning_effort: "high",
        approval_mode: "ask",
    }, { path })).toMatchObject({
        model: "z-ai/glm-5.2",
        reasoning_effort: "high",
        approval_mode: "ask",
    });
    expect(loadVeraConfig({ path })).toMatchObject({
        model: "z-ai/glm-5.2",
        reasoning_effort: "high",
        approval_mode: "ask",
    });
});

test("switching providers clears a provider-specific fallback", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "primary/model",
        fallback: { model: "backup/model", after_failures: 2 },
    }));

    expect(updateVeraConfigDefaults({
        provider: "ollama",
        model: "local-model",
    }, { path })).toMatchObject({
        provider: "ollama",
        model: "local-model",
        fallback: undefined,
    });
});

function temporaryConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-config-")), "config.json");
}
