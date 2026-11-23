import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import { MODELS_FIRST_PAGE, MODELS_PAGE_SIZE, modelRows, ModelsEmptyState, ModelsSection } from "../../clients/ui/src/pages/settings/ModelsSection.tsx";
import type { ModelEntry, ModelSettings } from "../../clients/ui/src/models/settings.ts";
import type { ProviderStatus } from "../../clients/ui/src/protocol/bridge.ts";

const providers: readonly ProviderStatus[] = [
    { id: "openai", name: "OpenAI", methods: ["key"], connected: true, catalog_connected: true, enabled: true, custom: false },
    { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: false, catalog_connected: false, enabled: true, custom: false },
];

function entry(provider: string, index: number): ModelEntry {
    return {
        provider,
        model: `model-${index}`,
        label: `Model ${index}`,
        onPareto: false,
        verified: false,
        hidden: false,
        recommended: false,
        levels: [],
        available: true,
    };
}

const settings: ModelSettings = {
    provider: "openai",
    model: "model-0",
    efforts: [],
    shortlist: [entry("openai", 2), entry("openai", 1)],
    catalog: [...Array.from({ length: 61 }, (_, index) => entry("openai", index)), entry("deepseek", 0)],
    refreshableProviders: ["openai"],
};

describe("Settings Models section", () => {
    test("orders kept models first, excludes disconnected providers, and searches labels and providers", () => {
        const rows = modelRows(settings, providers, "");
        expect(rows.slice(0, 2).map((row) => row.model)).toEqual(["model-2", "model-1"]);
        expect(rows).toHaveLength(61);
        expect(modelRows(settings, providers, "OPENAI")).toHaveLength(61);
        expect(modelRows(settings, providers, "model-5")).toHaveLength(11);
    });

    test("uses bounded initial and expanded page sizes and exposes the expected controls", () => {
        expect(MODELS_FIRST_PAGE).toBe(12);
        expect(MODELS_PAGE_SIZE).toBe(50);
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
        Object.defineProperty(globalThis, "window", { configurable: true, value: { veraDesktop: undefined } });
        const html = renderToStaticMarkup(createElement(ModelsSection, { onProviders: () => undefined }));
        if (previousWindow === undefined) delete (globalThis as typeof globalThis & { window?: Window }).window;
        else Object.defineProperty(globalThis, "window", previousWindow);
        expect(html).toContain('aria-label="Search models"');
        expect(html).toContain('aria-label="Refresh"');
        expect(html).toContain("Models that are on appear in the model picker.");
        const empty = renderToStaticMarkup(createElement(ModelsEmptyState, { onProviders: () => undefined }));
        expect(empty).toContain(">Connect a provider</button> to choose its models.");
    });
});
