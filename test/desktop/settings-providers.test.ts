import { describe, expect, test } from "bun:test";

import { listedLabel, providerDescription } from "../../clients/ui/src/pages/settings/providers.ts";
import type { ModelEntry, ModelSettings } from "../../clients/ui/src/models/settings.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");

function entry(provider: string, model: string): ModelEntry {
    return { provider, model, label: model, onPareto: false, verified: false, hidden: false, recommended: false, levels: [], available: true };
}

function settingsWith(catalog: readonly ModelEntry[]): ModelSettings {
    return { model: "m", efforts: [], shortlist: [], catalog };
}

describe("providerDescription", () => {
    const settings = settingsWith([entry("acme", "a1"), entry("acme", "a2"), entry("openrouter", "o1")]);

    test("counts only the models that provider lists", () => {
        expect(providerDescription(settings, { id: "acme", label: "Acme" }, NOW)).toBe("2 models");
        expect(providerDescription(settings, { id: "openrouter", label: "OpenRouter" }, NOW)).toBe("1 model");
    });

    test("adds when the list was refreshed", () => {
        const refreshedAt = new Date(NOW - 3 * 60 * 60_000).toISOString();
        expect(providerDescription(settings, { id: "acme", label: "Acme", refreshedAt }, NOW))
            .toBe("2 models · listed 3h ago");
    });

    test("a provider with no models reads zero models", () => {
        expect(providerDescription(settings, { id: "missing", label: "Missing" }, NOW)).toBe("0 models");
    });
});

describe("listedLabel", () => {
    test("recent listings read as an age", () => {
        expect(listedLabel(new Date(NOW - 20_000).toISOString(), NOW)).toBe("just now");
        expect(listedLabel(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe("12m ago");
        expect(listedLabel(new Date(NOW - 5 * 60 * 60_000).toISOString(), NOW)).toBe("5h ago");
        expect(listedLabel(new Date(NOW - 2 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("2d ago");
    });

    test("a listing a week or older reads as a date", () => {
        const at = new Date(NOW - 10 * 24 * 60 * 60_000);
        expect(listedLabel(at.toISOString(), NOW))
            .toBe(at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
    });

    test("a stamp that does not parse is left out", () => {
        expect(listedLabel("not a date", NOW)).toBeUndefined();
    });
});
