import { expect, test } from "bun:test";

import type { PoolFile } from "../../src/model/pool-file.ts";
import type { StoredCredential } from "../../src/providers/auth-storage.ts";
import {
    credentialRefusal,
    currentStep,
    openGate,
    providerAnswerLabel,
    providerAnswerState,
    stepperSteps,
} from "../../src/providers/onboarding.ts";
import {
    configuredProviders,
    findProvider,
} from "../../src/providers/registry.ts";

const PROVIDERS = configuredProviders(undefined);

const NO_ENV: Record<string, string | undefined> = {};

const EMPTY_POOL: PoolFile = { defaults: {}, models: {} };

function poolWith(id: string, probeOk: boolean): PoolFile {
    return {
        defaults: {},
        models: {
            [id]: {
                added: true,
                learned: { probe: { ok: probeOk, seen: "2026-09-02" } },
            },
        },
    };
}

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

test("a cold install is stopped at the provider gate", () => {
    expect(openGate({
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe("provider");
});

test("a stored key moves the gate to the model", () => {
    // The key is in. Nothing has answered yet, so this is not ready.
    expect(openGate({
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        config: { provider: "openrouter" },
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("model");
});

test("the provider in use missing its key is the key gate", () => {
    // Another provider is connected, so the flow is past choosing one; the
    // config names the one that still needs a credential.
    expect(openGate({
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        config: { provider: "cerebras" },
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("key");
});

test("a model that answered clears every gate", () => {
    expect(openGate({
        providers: PROVIDERS,
        pool: poolWith("openrouter/one/model", true),
        config: { provider: "openrouter" },
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("ready");
});

test("a model that was probed and failed does not clear a gate", () => {
    expect(openGate({
        providers: PROVIDERS,
        pool: poolWith("openrouter/one/model", false),
        config: { provider: "openrouter" },
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("model");
});

test("a stored key that has never answered reads key stored", () => {
    // The old boolean called this connected, which is the lie this replaces.
    expect(providerAnswerState(findProvider("openrouter")!, {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("key stored");
    expect(providerAnswerState(findProvider("openrouter")!, {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: { OPENROUTER_API_KEY: "from-env" },
    })).toBe("key stored");
});

test("connected means one of that provider's models answered", () => {
    expect(providerAnswerState(findProvider("openrouter")!, {
        providers: PROVIDERS,
        pool: poolWith("openrouter/one/model", true),
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("connected");
    // Another provider's answer says nothing about this one.
    expect(providerAnswerState(findProvider("cerebras")!, {
        providers: PROVIDERS,
        pool: poolWith("openrouter/one/model", true),
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("not answering");
});

test("a local provider with nothing listening reads not answering", () => {
    // It needs no key, so it holds none, and it has not answered either.
    expect(providerAnswerState(findProvider("ollama")!, {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: { OLLAMA_HOST: "http://localhost:11434" },
    })).toBe("not answering");
});

test("a denied model is not an answer", () => {
    // Shortlisted, probed, and then denied by policy: it cannot be selected,
    // so it cannot be the thing that proves the provider works.
    const pool: PoolFile = {
        defaults: { deny: ["openrouter/*"] },
        models: poolWith("openrouter/one/model", true).models,
    };
    expect(providerAnswerState(findProvider("openrouter")!, {
        providers: PROVIDERS,
        pool,
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
    })).toBe("key stored");
});

test("a provider whose key is optional shows no word until it is touched", () => {
    // oMLX can hold a key but was never given one, so its row stays silent
    // like every other untouched key provider.
    expect(providerAnswerLabel(findProvider("omlx")!, {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
    })).toBeUndefined();
    expect(providerAnswerLabel(findProvider("ollama")!, {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
    })).toBe("not answering");
});

function stateOf(steps: readonly { id: string; state: string }[], id: string) {
    return steps.find((step) => step.id === id)?.state;
}

test("a stepper with nothing chosen sits on the provider step", () => {
    const steps = stepperSteps({
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
    });
    expect(stateOf(steps, "provider")).toBe("current");
    expect(stateOf(steps, "key")).toBe("locked");
    expect(stateOf(steps, "model")).toBe("locked");
});

test("choosing a provider that needs a key moves the stepper to the key", () => {
    const input = {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
        chosen: "openrouter",
    };
    expect(stateOf(stepperSteps(input), "provider")).toBe("done");
    expect(currentStep(input)).toBe("key");
    expect(stateOf(stepperSteps(input), "model")).toBe("locked");
});

test("a credential-free provider shows the key step done, not hidden", () => {
    // The gate existed and was already clear, so the user sees it cleared.
    const input = {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
        chosen: "ollama",
    };
    expect(stateOf(stepperSteps(input), "key")).toBe("done");
    expect(currentStep(input)).toBe("model");
});

test("a stored key clears the key step and opens the model step", () => {
    const input = {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
        chosen: "openrouter",
    };
    expect(stateOf(stepperSteps(input), "key")).toBe("done");
    expect(currentStep(input)).toBe("model");
});

test("a model that answered leaves no step current", () => {
    // Every gate is clear, which is when the flow closes.
    const input = {
        providers: PROVIDERS,
        pool: poolWith("openrouter/one/model", true),
        authStorage: storage({ openrouter: "stored" }),
        env: NO_ENV,
        chosen: "openrouter",
    };
    expect(stepperSteps(input).map((step) => step.state)).toEqual([
        "done",
        "done",
        "done",
    ]);
    expect(currentStep(input)).toBeUndefined();
});

test("a provider chosen that is not configured leaves the stepper on provider", () => {
    const input = {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({}),
        env: NO_ENV,
        chosen: "not-a-provider",
    };
    expect(currentStep(input)).toBe("provider");
});

test("the step the client has open wins over the key it already holds", () => {
    const input = {
        providers: PROVIDERS,
        pool: EMPTY_POOL,
        authStorage: storage({ openrouter: "refused" }),
        env: NO_ENV,
        chosen: "openrouter",
        at: "key" as const,
    };
    expect(stateOf(stepperSteps(input), "key")).toBe("current");
    expect(stateOf(stepperSteps(input), "model")).toBe("locked");
});

test("a 401 hands back the provider's own sentence, not the envelope", () => {
    const refusal = credentialRefusal({
        verdict: "incompatible",
        statusCode: 401,
        reason:
            'deepseek returned 401 {"error":{"message":"Authentication Fails, Your api key: ****-key is invalid"}}',
    });
    expect(refusal).toBe(
        "Authentication Fails, Your api key: ****-key is invalid",
    );
});

test("a refusal with no JSON in it is shown as it came", () => {
    expect(credentialRefusal({ verdict: "incompatible", statusCode: 403, reason: "forbidden" }))
        .toBe("forbidden");
    expect(credentialRefusal({ verdict: "incompatible", statusCode: 401 }))
        .toBe("no reason given");
});

test("a failure that is not about the key keeps the user on the model step", () => {
    expect(credentialRefusal({ verdict: "added" })).toBeUndefined();
    expect(
        credentialRefusal({
            verdict: "unavailable",
            statusCode: 503,
            reason: "the provider is down",
        }),
    ).toBeUndefined();
    expect(credentialRefusal({ verdict: "pool_write_refused" })).toBeUndefined();
});
