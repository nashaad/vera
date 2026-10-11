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
    cache: { mode: "automatic", usage: ["read"] },
} as const;

const { cache: _cache, ...uncached } = standard;

test("shipped provider facts come from validated resource data", () => {
    expect(shippedProviderDefinitions().map((definition) => definition.id)).toEqual([
        "cerebras",
        "deepseek",
        "openai-codex",
        "openrouter",
        "outrider",
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

test("every provider definition says how it caches prompts", () => {
    expect(() => parseProviderDefinition(uncached, "fixture"))
        .toThrow(/cache is required/);
    expect(() => parseProviderDefinition({
        ...standard,
        cache: { mode: "breakpoints", usage: ["read"] },
    }, "fixture")).toThrow(/does not fit protocol openai-chat/);
    expect(() => parseProviderDefinition({
        ...standard,
        cache: { mode: "none", usage: ["read"] },
    }, "fixture")).toThrow(/mode none cannot report usage/);
    expect(() => parseProviderDefinition({
        ...standard,
        cache: { mode: "key", usage: ["read", "read"] },
    }, "fixture")).toThrow(/once each/);
    expect(() => parseProviderDefinition({
        ...standard,
        cache: { mode: "key", usage: [], affinity_header: "x-crow id" },
    }, "fixture")).toThrow(/header name/);
    expect(parseProviderDefinition({
        ...standard,
        cache: { mode: "key", usage: ["read"], affinity_header: "x-session-affinity" },
    }, "fixture").cache).toEqual({
        mode: "key",
        usage: ["read"],
        affinity_header: "x-session-affinity",
    });
});

test("declared providers take their cache from the protocol, extensions default to none", () => {
    const resolved = resolveProviders({
        contributed: [uncached],
        providers: {
            "crow-messages": {
                protocol: "anthropic-messages",
                base_url: "https://crow.example/v1",
                credential: "api_key",
            },
            "crow-chat": {
                protocol: "openai-chat",
                base_url: "https://crow.example/v1",
                credential: "api_key",
            },
        },
    });
    const cache = (id: string) => resolved.find((entry) => entry.id === id)?.definition.cache;

    expect(cache("fixture-provider")).toEqual({ mode: "none", usage: [] });
    expect(cache("crow-messages")).toEqual({ mode: "breakpoints", usage: ["read", "write"] });
    expect(cache("crow-chat")).toEqual({ mode: "automatic", usage: ["read"] });
});

test("a declared cache block replaces the protocol default and is checked against it", () => {
    const declared = (cache: unknown) => resolveProviders({
        providers: {
            "crow-gateway": {
                protocol: "openai-chat",
                base_url: "https://crow.example/v1",
                credential: "api_key",
                cache,
            } as never,
        },
    }).find((entry) => entry.id === "crow-gateway")?.definition.cache;

    expect(declared({ mode: "key", usage: ["read", "write"], affinity_header: "x-crow-session" }))
        .toEqual({ mode: "key", usage: ["read", "write"], affinity_header: "x-crow-session" });
    expect(declared({ mode: "none", usage: [] })).toEqual({ mode: "none", usage: [] });
    expect(() => declared({ mode: "breakpoints", usage: ["read"] }))
        .toThrow(/cache mode breakpoints does not fit protocol openai-chat/);
});

test("duplicate contributed ids fail rather than silently changing precedence", () => {
    expect(() => resolveProviders({ contributed: [standard, standard] }))
        .toThrow(/Duplicate provider definition fixture-provider/);
});

test("fixed endpoint overrides are rejected by the resolver", () => {
    expect(() => resolveProviders({ provider_endpoints: { "openai-codex": "https://proxy.example" } }))
        .toThrow(/fixed endpoint/);
});
