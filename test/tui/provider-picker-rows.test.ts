/** The provider screen on a machine that has connected nothing. Every provider is still offered, which is the only way a first run reaches one. */

import { expect, test } from "bun:test";
import { providerPickerRows } from "../../clients/tui/main/model-pickers.ts";
import { configuredProviders, setupProviders } from "../../src/providers/registry.ts";
import type { OnboardingInput } from "../../src/providers/onboarding.ts";

const EMPTY_FACTS = {
    connected: new Set<string>(),
    declared: new Set<string>(),
    refreshable: () => false,
    hasCredential: () => false,
    catalog: () => ({ models: [] as readonly unknown[] }),
};

function answers(providers: ReturnType<typeof configuredProviders>): OnboardingInput {
    return { providers, pool: { defaults: {}, models: {} }, authStorage: { getCredential: () => undefined } };
}

test("a home with nothing connected is still offered every provider", () => {
    const providers = configuredProviders(undefined);
    const rows = providerPickerRows(providers, answers(providers), EMPTY_FACTS);
    expect(rows.map((row) => row.id)).toEqual(providers.map((row) => row.id));
});

test("an untouched local provider reads unverified", () => {
    const providers = setupProviders(undefined);
    const rows = providerPickerRows(providers, answers(providers), EMPTY_FACTS);
    expect(rows.find((row) => row.id === "ollama")?.answerState).toBe("unverified");
});

test("the provider picker offers Outrider only when setup is enabled", () => {
    const hidden = setupProviders(undefined);
    const enabled = setupProviders({ experimental: { outrider_onboarding: true } });
    expect(providerPickerRows(hidden, answers(hidden), EMPTY_FACTS)
        .some((row) => row.id === "outrider")).toBe(false);
    expect(providerPickerRows(enabled, answers(enabled), EMPTY_FACTS)
        .some((row) => row.id === "outrider")).toBe(true);
});

test("a provider that has not connected says nothing about a catalog", () => {
    const providers = configuredProviders(undefined);
    const rows = providerPickerRows(providers, answers(providers), EMPTY_FACTS);
    expect(rows.every((row) => !(row.hint ?? "").includes("catalog"))).toBe(true);
});

test("a connected provider carries what its catalog holds", () => {
    const providers = configuredProviders(undefined);
    const rows = providerPickerRows(providers, answers(providers), {
        ...EMPTY_FACTS,
        connected: new Set(["openrouter"]),
        catalog: (id: string) => id === "openrouter"
            ? { fetched_at: "2026-09-17T00:00:00Z", models: [{}, {}] }
            : { models: [] },
    });
    const openrouter = rows.find((row) => row.id === "openrouter");
    expect(openrouter?.hint).toContain("catalog read: 2 models");
    expect(openrouter?.answerState).toBe("connected");
});
