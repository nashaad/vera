import { expect, test } from "bun:test";

import {
    createExecutableProviderAdapter,
    executableProviderBehaviorIds,
} from "../../src/providers/executable-contributions.ts";
import { configuredProviders } from "../../src/providers/registry.ts";

const PROVIDERS = configuredProviders(undefined);

const auth = {
    getCredential: () => undefined,
    setCredential: () => {},
    deleteCredential: () => {},
};

test("every contributed behavior is named by data and has a typed local factory", () => {
    const contributed = PROVIDERS.filter((provider) => provider.behaviorId !== undefined);
    expect(contributed.flatMap((provider) => provider.behaviorId === undefined ? [] : [provider.behaviorId]).sort()).toEqual(
        [...executableProviderBehaviorIds()],
    );
    for (const provider of contributed) {
        expect(() => createExecutableProviderAdapter(provider.behaviorId, provider, {
            authStorage: auth,
            env: { OPENROUTER_API_KEY: "test-key" },
        })).not.toThrow();
    }
});

test("unknown executable behavior fails clearly instead of becoming a vendor branch", () => {
    expect(() => createExecutableProviderAdapter(
        "missing-behavior",
        PROVIDERS[0]!,
        {},
    )).toThrow(/Unknown executable provider behavior missing-behavior/);
});
