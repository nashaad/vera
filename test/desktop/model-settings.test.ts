import { describe, expect, test } from "bun:test";

import {
    allModels,
    blendedRate,
    browseRows,
    effortLabel,
    findModel,
    formatContext,
    formatListed,
    modelName,
    onShortlist,
    shortModelName,
} from "../../clients/ui/src/models/catalog.ts";
import { effortCommand, getModelSettingsCommand, switchModelCommand } from "../../clients/ui/src/models/commands.ts";
import { parseModelSettings } from "../../clients/ui/src/models/settings.ts";
import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import { parseSessionLine } from "../../clients/ui/src/session/wire.ts";
import { blendedRate as veraBlendedRate } from "../../src/model/listed-rates.ts";

const wireSettings = {
    provider: "deepseek",
    model: "flash",
    reasoningEffort: "high",
    requestedReasoningEffort: "high",
    availableReasoningEfforts: ["low", "high"],
    contextWindow: 128000,
    pooled: [
        { provider: "deepseek", model: "flash", label: "Flash", displayName: "Quick", available: true, levels: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultLevel: "low", pricing: { input: 1, output: 4 } },
        { provider: "gone", model: "old", label: "Old", available: false, levels: [] },
    ],
    availableModels: [
        { provider: "deepseek", model: "flash", label: "Flash", levels: [], pricing: { input: 1, output: 4 }, waScore: 1460, onPareto: true },
        { provider: "glm", model: "big", label: "Big", levels: [], waScore: 1510, imageSupport: true, verified: true },
        { provider: "glm", model: "tiny", label: "Tiny", levels: [], hiddenByDefault: "deprecated" },
        { provider: "glm", label: "No model id" },
    ],
    subagentDefault: { mode: "fixed", provider: "glm", model: "big" },
    reviewerDefault: { mode: "agent" },
    providerCatalogs: [{ id: "deepseek", label: "DeepSeek", refreshedAt: "2026-11-12T00:00:00Z" }, { id: 3 }],
};

describe("model settings", () => {
    test("@core parses the host's settings and drops malformed rows", () => {
        const settings = parseModelSettings(wireSettings);
        expect(settings).toBeDefined();
        if (settings === undefined) return;
        expect(settings.model).toBe("flash");
        expect(settings.effort).toBe("high");
        expect(settings.requestedEffort).toBeUndefined();
        expect(settings.shortlist.map((entry) => entry.label)).toEqual(["Quick", "Old"]);
        expect(settings.shortlist[1]?.available).toBe(false);
        expect(settings.catalog).toHaveLength(3);
        expect(settings.catalog[2]?.hidden).toBe(true);
        expect(settings.subagentDefault).toEqual({ mode: "fixed", choice: { provider: "glm", model: "big" } });
        expect(settings.providers).toEqual([{ id: "deepseek", label: "DeepSeek", refreshedAt: "2026-11-12T00:00:00Z" }]);
        expect(parseModelSettings({ provider: "x" })).toBeUndefined();
    });

    test("the pill name drops a vendor prefix but keeps a name the person gave", () => {
        const settings = parseModelSettings({
            provider: "openrouter",
            model: "openai/gpt-5.6-luna",
            pooled: [
                { provider: "openrouter", model: "openai/gpt-5.6-luna", label: "OpenAI: GPT-5.6 Luna", available: true, levels: [] },
                { provider: "openrouter", model: "z-ai/glm-4.6", label: "Z.AI: GLM 4.6", displayName: "Crow: night shift", available: true, levels: [] },
            ],
            availableModels: [
                { provider: "deepseek", model: "flash", label: "Flash", levels: [] },
                { provider: "openrouter", model: "odd", label: "Odd:", levels: [] },
            ],
        })!;
        expect(shortModelName(settings, { provider: "openrouter", model: "openai/gpt-5.6-luna" })).toBe("GPT-5.6 Luna");
        expect(modelName(settings, { provider: "openrouter", model: "openai/gpt-5.6-luna" })).toBe("OpenAI: GPT-5.6 Luna");
        expect(shortModelName(settings, { provider: "openrouter", model: "z-ai/glm-4.6" })).toBe("Crow: night shift");
        expect(shortModelName(settings, { provider: "deepseek", model: "flash" })).toBe("Flash");
        expect(shortModelName(settings, { provider: "openrouter", model: "odd" })).toBe("Odd:");
        expect(shortModelName(settings, { provider: "openrouter", model: "unlisted" })).toBe("unlisted");
    });

    test("finds the shortlist copy first and merges both lists", () => {
        const settings = parseModelSettings(wireSettings)!;
        expect(modelName(settings, { provider: "deepseek", model: "flash" })).toBe("Quick");
        expect(findModel(settings, { model: "big" })?.provider).toBe("glm");
        expect(onShortlist(settings, { provider: "glm", model: "big" })).toBe(false);
        expect(allModels(settings).map((entry) => entry.model)).toEqual(["flash", "old", "big", "tiny"]);
        expect(effortLabel(settings, "high")).toBe("High");
        expect(effortLabel(settings, "x_high")).toBe("X high");
        expect(effortLabel(settings, undefined)).toBe("Default");
    });

    test("hides marked rows until a search and filters by score", () => {
        const settings = parseModelSettings(wireSettings)!;
        expect(browseRows(settings.catalog, "", "any").map((entry) => entry.model)).toEqual(["flash", "big"]);
        expect(browseRows(settings.catalog, "tiny", "any").map((entry) => entry.model)).toEqual(["tiny"]);
        expect(browseRows(settings.catalog, "", "1500").map((entry) => entry.model)).toEqual(["big"]);
        expect(browseRows(settings.catalog, "glm big", "any").map((entry) => entry.model)).toEqual(["big"]);
    });

    test("@core blends prices the way Vera does", () => {
        for (const pricing of [{ input: 1, output: 4 }, { input: 0.27, output: 1.1 }, { input: 15, output: 75 }]) {
            expect(blendedRate(pricing)).toBe(veraBlendedRate(pricing));
        }
        expect(formatListed({ input: 0, output: 0 })).toBe("free");
        expect(formatListed({ input: 1.5, output: 4 })).toBe("$1.5 in, $4 out");
        expect(formatContext(128000)).toBe("128K");
        expect(formatContext(1_000_000)).toBe("1M");
    });

    test("builds the session lines that read and change the model", () => {
        expect(JSON.parse(getModelSettingsCommand("r1"))).toEqual({ type: "get_model_settings", requestId: "r1" });
        expect(JSON.parse(switchModelCommand("r2", "glm", "big"))).toEqual({
            type: "update_model_settings",
            requestId: "r2",
            patch: { provider: "glm", model: "big" },
        });
        expect(JSON.parse(switchModelCommand("r3", undefined, "big", null)).patch).toEqual({ model: "big", reasoningEffort: null });
        expect(JSON.parse(effortCommand("r4", "low")).patch).toEqual({ reasoningEffort: "low" });
    });

    test("@core a model_settings reply and a refusal reach the watch", () => {
        const reply = parseSessionLine(JSON.stringify({ type: "model_settings", requestId: "r1", settings: wireSettings, pending: true, seq: 4 }));
        const refusal = parseSessionLine(JSON.stringify({ type: "model_settings_rejected", requestId: "r2", reason: "unavailable" }));
        expect(reply?.type).toBe("model_settings");
        expect(refusal?.type).toBe("model_settings_rejected");
        if (reply === undefined || refusal === undefined) return;
        const watched = reduceWatch(reduceWatch(initialWatch("a1"), reply), refusal);
        expect(watched.models?.requestId).toBe("r1");
        expect(watched.models?.pending).toBe(true);
        expect(watched.models?.settings.model).toBe("flash");
        expect(watched.modelRefused).toEqual({ requestId: "r2", reason: "unavailable" });
    });
});
