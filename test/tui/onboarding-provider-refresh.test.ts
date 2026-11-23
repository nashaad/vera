import { expect, test } from "bun:test";

import { isRefreshableProvider } from "../../src/model/refreshable-providers.ts";
import { adoptedModelSettingsPatch } from "../../clients/tui/onboarding-model-default.ts";
import { renderTuiStatusDetailsLine } from "../../clients/tui/status.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { OnboardingInput } from "../../src/providers/onboarding.ts";
import { configuredProviders } from "../../src/providers/registry.ts";
import { onboardingCardLines } from "../../clients/tui/onboarding-screen.ts";
import { newWizardSession, wizardScreen } from "../../clients/tui/onboarding-wizard.ts";

const input: OnboardingInput = {
    providers: configuredProviders(undefined),
    pool: { defaults: {}, models: {} },
    authStorage: { getCredential: () => undefined },
    env: {},
};

test("DeepSeek onboarding uses its available list without a refresh warning", () => {
    expect(isRefreshableProvider("deepseek")).toBe(false);

    const screen = wizardScreen(input, {
        ...newWizardSession("model"),
        chosen: "deepseek",
    });
    const text = onboardingCardLines(screen).map((line) => line.text).join("\n");

    expect(text).not.toContain("Asking DeepSeek");
    expect(text).not.toContain("DeepSeek listed no models");
});

test("adopting a selected model sends its default effort to the footer", () => {
    const patch = adoptedModelSettingsPatch(
        "deepseek",
        "deepseek-v4-pro",
        "high",
    );
    expect(patch).toEqual({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        reasoningEffort: "high",
    });
    const settings: ModelTurnSettings = {
        provider: patch.provider ?? "deepseek",
        model: patch.model ?? "",
        reasoningEffort: patch.reasoningEffort ?? undefined,
    };
    expect(renderTuiStatusDetailsLine(settings, "auto", undefined, "/work"))
        .toContain("deepseek-v4-pro · high");
});

test("refreshable providers retain the onboarding catalog request path", () => {
    expect(isRefreshableProvider("openrouter")).toBe(true);
});
