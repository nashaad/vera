import { expect, test } from "bun:test";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import type { StoredCredential } from "../../src/providers/auth-storage.ts";
import {
    findProvider,
    isProviderConnected,
    PROVIDERS,
} from "../../src/providers/registry.ts";

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

test("a provider needing no credential is always connected", () => {
    // Whether the daemon is actually up is a different question, and only a
    // request can answer it. There is nothing here for the user to supply.
    expect(isProviderConnected(findProvider("ollama")!, {
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe(true);
});

test("a provider with no credentials names the command that fixes it", () => {
    expect(() => createConfiguredModelAdapter(
        { schema_version: 1, provider: "openrouter", model: "any/model", approval_mode: "ask" },
        { authStorage: storage({}), env: NO_ENV },
    )).toThrow(/model pane \(ctrl\+e\) or set OPENROUTER_API_KEY/);
});
