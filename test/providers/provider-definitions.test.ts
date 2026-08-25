import { expect, test } from "bun:test";

import {
    parseProviderDefinition,
    resolveProviders,
    shippedProviderDefinitions,
} from "../../src/providers/definitions.ts";

const standard = {
    schema_version: 1,
    id: "fixture-provider",
    label: "Fixture Provider",
    short_label: "fixture",
    access: "api_key",
    credential: "api_key",
    env_var: "FIXTURE_API_KEY",
    protocol: "openai-chat",
    default_base_url: "https://fixture.example/v1",
    discovery: { mode: "models", path: "/models", credential: "required" },
    compatibility: { request: ["openai-chat"], response: ["openai-sse"], error: ["http-status"] },
} as const;

test("shipped provider facts come from validated resource data", () => {
    expect(shippedProviderDefinitions().map((definition) => definition.id)).toEqual([
        "cerebras",
        "deepseek",
        "openai-codex",
        "openrouter",
        "ollama",
        "omlx",
        "digitalocean",
    ]);
    expect(shippedProviderDefinitions().find((definition) => definition.id === "openrouter"))
        .toMatchObject({ protocol: "contributed", behavior_id: "openrouter" });
});

test("a standard provider resolves from data without a provider-name branch", () => {
    const provider = resolveProviders({
        contributed: [standard],
        providers: {
            gateway: {
                protocol: "openai-chat",
                base_url: "https://gateway.example/v1",
                credential: "api_key",
            },
        },
    });

    expect(provider.find((entry) => entry.id === "fixture-provider")).toMatchObject({
        source: "extension",
        custom: false,
        baseUrl: "https://fixture.example/v1",
    });
    expect(provider.find((entry) => entry.id === "gateway")).toMatchObject({
        source: "profile",
        custom: true,
        definition: { protocol: "openai-chat", discovery: { mode: "models" } },
    });
});

test("provider definitions reject unsafe, unknown, and incompatible facts", () => {
    expect(() => parseProviderDefinition({ ...standard, schema_version: 2 }, "fixture"))
        .toThrow(/unsupported schema_version/);
    expect(() => parseProviderDefinition({ ...standard, default_base_url: "file:///secret" }, "fixture"))
        .toThrow(/unsafe default_base_url/);
    expect(() => parseProviderDefinition({ ...standard, id: "../../fixture" }, "fixture"))
        .toThrow(/lowercase provider slug/);
    expect(() => parseProviderDefinition({
        ...standard,
        compatibility: { request: ["unknown-layer"] },
    }, "fixture")).toThrow(/unknown compatibility layer/);
    expect(() => parseProviderDefinition({
        ...standard,
        credential: "oauth",
    }, "fixture")).toThrow(/oauth requires contributed/);
});

test("duplicate contributed ids fail rather than silently changing precedence", () => {
    expect(() => resolveProviders({ contributed: [standard, standard] }))
        .toThrow(/Duplicate provider definition fixture-provider/);
});

test("fixed endpoint overrides are rejected by the resolver", () => {
    expect(() => resolveProviders({ provider_endpoints: { "openai-codex": "https://proxy.example" } }))
        .toThrow(/fixed endpoint/);
});
