import { expect, test } from "bun:test";
import { startingVeraConfig } from "../../src/config.ts";
import {
    shouldAdoptFirstOnboardingModel,
    shouldAdoptOnboardingModel,
    shouldAdoptWizardModel,
} from "../../clients/tui/onboarding-model-default.ts";

const starter = startingVeraConfig();

test("@core the first configured model replaces an unused starter default", () => {
    expect(shouldAdoptFirstOnboardingModel(starter, false, false)).toBe(true);
});

test("@core a configured default stays when another provider is added", () => {
    expect(shouldAdoptFirstOnboardingModel({ ...starter, model: "openai/gpt-5.6-luna" }, false, false))
        .toBe(false);
});

test("@core a starter model stays after an assistant response used it", () => {
    expect(shouldAdoptFirstOnboardingModel(starter, false, true)).toBe(false);
});

test("@core a session-specific model assignment stays in place", () => {
    expect(shouldAdoptFirstOnboardingModel(starter, true, false)).toBe(false);
});

test("@core a first configured provider replaces an unused starter default", () => {
    expect(shouldAdoptOnboardingModel({
        config: starter,
        provider: "deepseek",
        currentProvider: "openrouter",
        hasAssignedDefault: false,
        modelUsedBefore: false,
    })).toBe(true);
});

test("@core a prior assistant response preserves the active model", () => {
    expect(shouldAdoptOnboardingModel({
        config: starter,
        provider: "openrouter",
        currentProvider: "openrouter",
        hasAssignedDefault: false,
        modelUsedBefore: true,
    })).toBe(false);
});

test("@core another provider does not replace an assigned default", () => {
    expect(shouldAdoptOnboardingModel({
        config: { ...starter, model: "openai/gpt-5.6-luna" },
        provider: "deepseek",
        currentProvider: "openrouter",
        hasAssignedDefault: true,
        modelUsedBefore: false,
    })).toBe(false);
});

test("@core choosing a model for the current provider updates its assigned default", () => {
    expect(shouldAdoptOnboardingModel({
        config: starter,
        provider: "openrouter",
        currentProvider: "openrouter",
        hasAssignedDefault: true,
        modelUsedBefore: false,
    })).toBe(true);
});

test("@core the wizard adopts the first provider for an unused starter session", () => {
    expect(shouldAdoptWizardModel(starter, {
        modelSettings: { provider: starter.provider, model: starter.model },
        modelSettingsOrigin: "agent-default",
        entries: [],
    }, "deepseek")).toBe(true);
});

test("@core the wizard preserves a model used in the active transcript", () => {
    expect(shouldAdoptWizardModel(starter, {
        modelSettings: { provider: starter.provider, model: starter.model },
        modelSettingsOrigin: "agent-default",
        entries: [{ kind: "assistant", text: "An earlier answer" }],
    }, "deepseek")).toBe(false);
});

test("@core the wizard preserves a non-starter default", () => {
    const configured = { ...starter, model: "openai/gpt-5.6-luna" };
    expect(shouldAdoptWizardModel(configured, {
        modelSettings: { provider: configured.provider, model: configured.model },
        modelSettingsOrigin: "agent-default",
        entries: [],
    }, "deepseek")).toBe(false);
});
