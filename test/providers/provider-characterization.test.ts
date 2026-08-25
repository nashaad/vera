import { expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
    type VeraConfig,
} from "../../src/config.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import type { StoredCredential } from "../../src/providers/auth-storage.ts";
import {
    configuredProviders,
    findProvider,
    isProviderConnected,
    PROVIDERS,
} from "../../src/providers/registry.ts";
import { isRefreshableProvider } from "../../src/model/refreshable-providers.ts";
import {
    diagnoseProviders,
    renderProviderDoctor,
} from "../../clients/provider-doctor.ts";
import { tuiProviderGroup } from "../../clients/tui/settings-picker.ts";

const NO_ENV: Record<string, string | undefined> = {};

function storage(
    credentials: Readonly<Record<string, StoredCredential>>,
) {
    return {
        getCredential: (provider: string) => credentials[provider],
        setCredential: () => {},
        deleteCredential: () => {},
    };
}

test("shipped and declared providers resolve to the current client facts", () => {
    const custom = {
        protocol: "openai-chat" as const,
        base_url: "https://gateway.example/v1",
        credential: "api_key" as const,
        api_key_env: "GATEWAY_API_KEY",
    };
    const providers = configuredProviders({
        providers: { gateway: custom },
        provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" },
    });

    expect(providers.map((provider) => provider.id)).toEqual([
        "cerebras",
        "deepseek",
        "openai-codex",
        "openrouter",
        "ollama",
        "omlx",
        "gateway",
    ]);
    expect(providers.find((provider) => provider.id === "cerebras"))
        .toMatchObject({
            label: "Cerebras",
            shortLabel: "cerebras",
            access: "api_key",
            credential: "api_key",
            hint: "API key",
            envVar: "CEREBRAS_API_KEY",
            baseUrl: "https://eu.cerebras.example/v1",
        });
    expect(providers.find((provider) => provider.id === "gateway"))
        .toEqual({
            id: "gateway",
            label: "gateway",
            shortLabel: "gateway",
            access: "api_key",
            credential: "api_key",
            hint: "API key or GATEWAY_API_KEY",
            envVar: "GATEWAY_API_KEY",
            baseUrl: "https://gateway.example/v1",
        });
});

test("credential state prefers stored keys while preserving environment fallback", () => {
    const openrouter = findProvider("openrouter");
    expect(openrouter).toBeDefined();

    expect(isProviderConnected(openrouter!, {
        authStorage: storage({
            openrouter: { type: "api_key", key: "stored-only-for-test" },
        }),
        env: { OPENROUTER_API_KEY: "environment-only-for-test" },
    })).toBe(true);
    expect(isProviderConnected(openrouter!, {
        authStorage: storage({}),
        env: { OPENROUTER_API_KEY: "environment-only-for-test" },
    })).toBe(true);
    expect(isProviderConnected(openrouter!, {
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe(false);

    expect(isProviderConnected(findProvider("ollama")!, {
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe(true);
});

test("endpoint overrides are visible to rows while fixed endpoints are rejected by config", () => {
    const moved = configuredProviders({
        provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" },
    }).find((provider) => provider.id === "cerebras");
    expect(moved?.baseUrl).toBe("https://eu.cerebras.example/v1");
    expect(configuredProviders(undefined)
        .find((provider) => provider.id === "openai-codex")?.fixedEndpoint)
        .toBe(true);

    const directory = mkdtempSync(join(tmpdir(), "vera-provider-characterization-"));
    try {
        const path = join(directory, "config.json");
        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "some-model",
            approval_mode: "ask",
        }));

        expect(() => updateVeraConfigDefaults(
            {
                provider_endpoint: {
                    id: "openai-codex",
                    url: "https://elsewhere.example/v1",
                },
            },
            { path },
        )).toThrow(/cannot take endpoint/);

        expect(() => loadVeraConfig({ path })).not.toThrow();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("doctor resolves the same custom endpoint and credential policy", async () => {
    const storedKey = "stored-key-for-characterization";
    const report = await diagnoseProviders(
        {
            providers: {
                gateway: {
                    protocol: "openai-chat",
                    base_url: "https://gateway.example/v1",
                    credential: "api_key",
                    api_key_env: "GATEWAY_API_KEY",
                },
            },
        },
        {
            authStorage: storage({
                gateway: { type: "api_key", key: storedKey },
            }),
            env: { GATEWAY_API_KEY: "environment-key-for-characterization" },
            checkNetwork: true,
            fetch: async (input, init) => {
                expect(String(input)).toBe("https://gateway.example/v1/models");
                expect(new Headers(init?.headers).get("authorization"))
                    .toBe(`Bearer ${storedKey}`);
                return new Response("{}", { status: 200 });
            },
        },
    );
    const provider = report.providers.find((entry) => entry.id === "gateway");
    expect(provider).toMatchObject({
        id: "gateway",
        custom: true,
        connected: true,
        credentialSource: "stored",
        endpoint: {
            baseUrl: "https://gateway.example/v1",
            protocol: "openai-chat",
        },
        probe: {
            reachability: "authenticated",
            url: "https://gateway.example/v1/models",
            status: 200,
        },
    });
    const rendered = renderProviderDoctor(report);
    expect(rendered).toContain("gateway");
    expect(rendered).not.toContain(storedKey);
    expect(rendered).toContain("Credential: stored");
});

test("provider access facts map to the current UI groups", () => {
    expect(PROVIDERS.map((provider) => tuiProviderGroup(provider.access)))
        .toEqual([
            "API keys",
            "API keys",
            "Subscriptions",
            "API keys",
            "Local",
            "Local",
        ]);
    expect(tuiProviderGroup("api_key", true)).toBe("Added in config");
});

test("refresh eligibility remains an explicit provider fact", () => {
    expect([
        "ollama",
        "omlx",
        "openrouter",
        "cerebras",
        "deepseek",
        "openai-codex",
        "gateway",
    ].map(isRefreshableProvider)).toEqual([
        true,
        true,
        true,
        true,
        false,
        false,
        false,
    ]);
});

test("every current shipped row still selects an adapter", () => {
    const configFor = (provider: string): VeraConfig => ({
        schema_version: 1,
        provider,
        model: "characterization-model",
        approval_mode: "ask",
    });
    const env = {
        CEREBRAS_API_KEY: "test-key",
        DEEPSEEK_API_KEY: "test-key",
        OPENROUTER_API_KEY: "test-key",
        OMLX_API_KEY: "test-key",
    };

    for (const provider of PROVIDERS) {
        expect(() => createConfiguredModelAdapter(configFor(provider.id), {
            authStorage: storage({}),
            env,
        })).not.toThrow();
    }
});

test("a declared OpenAI-compatible row selects the generic adapter", async () => {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "gateway",
        model: "characterization-model",
        approval_mode: "ask",
        providers: {
            gateway: {
                protocol: "openai-chat",
                base_url: "https://gateway.example/v1",
                credential: "api_key",
                api_key_env: "GATEWAY_API_KEY",
            },
        },
    }, {
        authStorage: storage({
            gateway: { type: "api_key", key: "stored-gateway-key" },
        }),
        env: { GATEWAY_API_KEY: "environment-gateway-key" },
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return new Response(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            );
        },
    });

    const result = await adapter.stream({
        model: "characterization-model",
        messages: [],
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(request?.url).toBe(
        "https://gateway.example/v1/chat/completions",
    );
    expect(request?.headers.get("authorization"))
        .toBe("Bearer stored-gateway-key");
});
