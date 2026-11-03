import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig, VeraConfigError } from "../../src/config.ts";

function configWithProviders(providers: Record<string, unknown>): string {
    const path = join(mkdtempSync(join(tmpdir(), "vera-shipped-provider-")), "config.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "one/model", providers }));
    return path;
}

function loadError(path: string): VeraConfigError {
    try {
        loadVeraConfig({ path });
    } catch (error) {
        if (error instanceof VeraConfigError) return error;
        throw error;
    }
    throw new Error("expected the config to be refused");
}

const declaration = { protocol: "openai-chat", base_url: "https://crow.example/v1", credential: "api_key" };

test("a shipped provider under providers names it and points to provider_endpoints", () => {
    const path = configWithProviders({ deepseek: declaration });
    const error = loadError(path);
    expect(error.path).toBe(path);
    expect(error.message).toContain('provider "deepseek" is built into Vera, so it cannot be declared under providers.');
    expect(error.message).toContain("set provider_endpoints.deepseek.");
    expect(error.message).not.toContain("not a Vera config");
});

test("a padded shipped provider id is named without its padding", () => {
    const error = loadError(configWithProviders({ " openrouter ": declaration }));
    expect(error.message).toContain('provider "openrouter" is built into Vera');
    expect(error.message).toContain("provider_endpoints.openrouter");
});

test("a fixed-endpoint shipped provider gets no provider_endpoints hint", () => {
    const error = loadError(configWithProviders({ "openai-codex": declaration }));
    expect(error.message).toContain('provider "openai-codex" is built into Vera');
    expect(error.message).not.toContain("provider_endpoints");
});

test("a custom provider beside the shipped ones still loads", () => {
    const config = loadVeraConfig({ path: configWithProviders({ "crow-lab": declaration }) });
    expect(Object.keys(config.providers ?? {})).toEqual(["crow-lab"]);
});
