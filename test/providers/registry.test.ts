import { expect, test } from "bun:test";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import type { VeraConfig } from "../../src/config.ts";
import type { StoredCredential } from "../../src/providers/auth-storage.ts";
import {
    configuredProviders,
    findProvider,
    isProviderConnected,
} from "../../src/providers/registry.ts";

const PROVIDERS = configuredProviders(undefined);

const NO_ENV: Record<string, string | undefined> = {};

function storage(tokens: Record<string, string>) {
    return {
        getCredential: (provider: string) => tokens[provider] === undefined
            ? undefined
            : { type: "api_key" as const, key: tokens[provider]! },
        setCredential: (provider: string, credential: StoredCredential) => {
            tokens[provider] = credential.type === "api_key"
                ? credential.key
                : credential.token;
        },
        deleteCredential: (provider: string) => {
            delete tokens[provider];
        },
    };
}

test("every listed provider has an adapter behind it", () => {
    // The registry is a promise that choosing a row runs a model. A row whose
    // adapter does not exist connects an account and then fails at the first
    // turn, which is worse than never listing it.
    for (const provider of PROVIDERS) {
        expect(() => createConfiguredModelAdapter(
            { schema_version: 1, provider: provider.id, model: "any/model", approval_mode: "ask" },
            { authStorage: storage({ [provider.id]: "token" }), env: NO_ENV },
        )).not.toThrow();
    }
});

test("a stored key is used ahead of the environment", () => {
    // Both work, and the stored one wins: it is what the user typed into Vera,
    // which is the more deliberate of the two.
    expect(isProviderConnected(findProvider("openrouter")!, {
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe(true);
    expect(isProviderConnected(findProvider("openrouter")!, {
        authStorage: storage({}),
        env: { OPENROUTER_API_KEY: "from-env" },
    })).toBe(true);
    expect(isProviderConnected(findProvider("openrouter")!, {
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe(false);
    expect(isProviderConnected(findProvider("cerebras")!, {
        authStorage: storage({}),
        env: { CEREBRAS_API_KEY: "from-env" },
    })).toBe(true);
    expect(isProviderConnected(findProvider("deepseek")!, {
        authStorage: storage({}),
        env: { DEEPSEEK_API_KEY: "from-env" },
    })).toBe(true);
});

test("local providers are connected before their daemon is probed", () => {
    // Whether the daemon is actually up is a different question, and only a
    // request can answer it. oMLX may also need a key, but its endpoint can
    // still be used without one.
    expect(isProviderConnected(findProvider("ollama")!, {
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe(true);
    expect(isProviderConnected(findProvider("omlx")!, {
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe(true);
});

test("provider access is explicit enough for clients to group without guessing", () => {
    expect(PROVIDERS.map((provider) => [provider.id, provider.access]))
        .toEqual([
            ["cerebras", "api_key"],
            ["deepseek", "api_key"],
            ["openai-codex", "subscription"],
            ["openrouter", "api_key"],
            ["ollama", "local"],
            ["omlx", "local"],
            ["digitalocean", "api_key"],
        ]);
});

test("a provider with no credentials names the command that fixes it", () => {
    expect(() => createConfiguredModelAdapter(
        { schema_version: 1, provider: "openrouter", model: "any/model", approval_mode: "ask" },
        { authStorage: storage({}), env: NO_ENV },
    )).toThrow(/model pane \(ctrl\+e\) or set OPENROUTER_API_KEY/);
});

test("the registry, the adapter map, and the config ids list the same providers", () => {
    expect([...PROVIDERS].map((provider) => provider.id).sort())
        .toEqual([...configuredProviders(undefined)].map((provider) => provider.id).sort());

    for (const id of PROVIDERS.map((provider) => provider.id)) {
        // A provider the registry offers but the adapter map cannot build
        // would connect in the pane and then fail at the first turn.
        expect(() =>
            createConfiguredModelAdapter(
                { provider: id, model: "some-model" } as VeraConfig,
                {
                    env: {
                        CEREBRAS_API_KEY: "k",
                        DEEPSEEK_API_KEY: "k",
                        OMLX_API_KEY: "k",
                        OPENROUTER_API_KEY: "k",
                    },
                },
            )
        ).not.toThrow(`Unknown provider ${id}`);
    }
});

test("a shipped provider's row shows the endpoint the config points it at", () => {
    const shipped = configuredProviders(undefined)
        .find((provider) => provider.id === "cerebras");
    expect(shipped?.baseUrl).toBe("https://api.cerebras.ai/v1");

    const moved = configuredProviders({
        provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" },
    }).find((provider) => provider.id === "cerebras");
    expect(moved?.baseUrl).toBe("https://eu.cerebras.example/v1");
});

test("every shipped provider names a host, and only Codex fixes it", () => {
    for (const provider of PROVIDERS) {
        expect(provider.baseUrl).toBeString();
    }
    expect(PROVIDERS.filter((provider) => provider.fixedEndpoint === true)
        .map((provider) => provider.id))
        .toEqual(["openai-codex"]);
});
