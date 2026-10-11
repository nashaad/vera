import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergedProviderDeclaration } from "../../clients/tui/settings-picker-provider-form.ts";
import { loadVeraConfig, updateVeraConfigDefaults, type VeraCustomProviderConfig } from "../../src/config.ts";

const handWritten: VeraCustomProviderConfig = {
    protocol: "anthropic-messages",
    base_url: "https://crows-nest.example/v1",
    credential: "api_key",
    api_key_env: "CROWS_NEST_KEY",
    images: true,
    max_tokens: 8_192,
    thinking: "adaptive",
    cache: { mode: "none", usage: [] },
};

test("saving the provider form keeps fields the form does not show", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-provider-form-")), "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "crows-nest",
        model: "crow/plunder",
        providers: { "crows-nest": handWritten },
    }));

    const previous = loadVeraConfig({ path }).providers?.["crows-nest"];
    updateVeraConfigDefaults({
        custom_provider: {
            id: "crows-nest",
            declaration: mergedProviderDeclaration(previous, {
                protocol: "anthropic-messages",
                base_url: "https://galleon.example/v1",
                credential: "api_key",
            }),
        },
    }, { path });

    expect(loadVeraConfig({ path }).providers?.["crows-nest"])
        .toEqual({ ...handWritten, base_url: "https://galleon.example/v1" });
});

test("a new protocol drops the fields checked against the old one", () => {
    expect(mergedProviderDeclaration(handWritten, {
        protocol: "openai-chat",
        base_url: "https://crows-nest.example/v1",
        credential: "api_key",
    })).toEqual({
        protocol: "openai-chat",
        base_url: "https://crows-nest.example/v1",
        credential: "api_key",
        api_key_env: "CROWS_NEST_KEY",
        images: true,
        max_tokens: 8_192,
    });
});

test("a brand new provider is saved as the form wrote it", () => {
    const edited: VeraCustomProviderConfig = {
        protocol: "openai-chat",
        base_url: "https://crows-nest.example/v1",
        credential: "none",
    };
    expect(mergedProviderDeclaration(undefined, edited)).toEqual(edited);
});
