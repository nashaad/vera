import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { availableModelsWithLevels } from "../../src/model/catalog-view.ts";
import { curatedSeed } from "../../src/model/curated-models.ts";
import { deepSeekCatalogModels, refreshDeepSeekCatalog } from "../../src/model/deepseek-catalog.ts";
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

test("the DeepSeek first-run wizard opens on the bundled Flash recommendation", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-deepseek-onboarding-"));
    try {
        const cacheDir = join(root, "cache");
        refreshDeepSeekCatalog({ cacheDir });
        const available = availableModelsWithLevels(deepSeekCatalogModels().map((model) => ({
            provider: "deepseek",
            model: model.id,
            label: model.label,
            description: model.description ?? "",
        })), { cacheDir, curated: curatedSeed(), userPath: join(root, "pool.json"), projectPath: join(root, "project-pool.json") });
        const screen = wizardScreen(input, {
            ...newWizardSession("model"),
            chosen: "deepseek",
            models: available.map((model) => ({ id: model.model, label: model.label })),
        });
        expect(screen.body.kind).toBe("choice");
        if (screen.body.kind !== "choice") throw new Error("Expected model choices");
        expect(screen.body.groups.flatMap((group) => group.rows.map((row) => row.id)))
            .toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("adopting a selected model sends its default effort to the footer", () => {
    const patch = adoptedModelSettingsPatch(
        "deepseek",
        "deepseek-flash",
        "high",
    );
    expect(patch).toEqual({
        provider: "deepseek",
        model: "deepseek-flash",
        reasoningEffort: "high",
    });
    const settings: ModelTurnSettings = {
        provider: patch.provider ?? "deepseek",
        model: patch.model ?? "",
        reasoningEffort: patch.reasoningEffort ?? undefined,
    };
    expect(renderTuiStatusDetailsLine(settings, "auto", undefined, "/work"))
        .toContain("deepseek-flash · high");
});

test("refreshable providers retain the onboarding catalog request path", () => {
    expect(isRefreshableProvider("openrouter")).toBe(true);
});
