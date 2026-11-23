import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { KeyStep, keyEcho } from "../../clients/ui/src/pages/settings/provider-wizard/KeyStep.tsx";
import { ModelStep } from "../../clients/ui/src/pages/settings/provider-wizard/ModelStep.tsx";
import { ProviderStep } from "../../clients/ui/src/pages/settings/provider-wizard/ProviderStep.tsx";
import { ProviderWizardFooter } from "../../clients/ui/src/pages/settings/provider-wizard/ProviderWizardFooter.tsx";
import { KeySaveConfirmation, keySaveConfirmation, ProviderWizard } from "../../clients/ui/src/pages/settings/ProviderWizard.tsx";
import type { ModelEntry } from "../../clients/ui/src/models/settings.ts";
import type { ProviderStatus } from "../../clients/ui/src/protocol/bridge.ts";

const providers: readonly ProviderStatus[] = [
    { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: false, catalog_connected: false, enabled: true, custom: false },
    { id: "local", name: "Local endpoint", methods: [], connected: true, catalog_connected: true, enabled: true, connected_by: "none", endpoint: "http://localhost:11434", custom: false },
    { id: "custom", name: "Custom Endpoint", methods: ["key"], connected: true, catalog_connected: true, enabled: true, custom: true, endpoint: "http://localhost:8080" },
];

const models: readonly ModelEntry[] = [
    { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", onPareto: false, verified: false, hidden: false, recommended: true, levels: [{ id: "max", label: "Max" }, { id: "high", label: "High" }, { id: "off", label: "Off" }], defaultLevel: "high", available: true },
    { provider: "deepseek", model: "deepseek-flash", label: "DeepSeek V4.1 Flash 1017", pricing: { input: 0.1, output: 0.3 }, onPareto: false, verified: false, hidden: false, recommended: false, levels: [{ id: "max", label: "Max" }, { id: "high", label: "High" }, { id: "off", label: "Off" }], defaultLevel: "high", available: true },
];

describe("provider wizard components", () => {
    test("successful key save confirmation renders with both bundled models", () => {
        const confirmation = keySaveConfirmation("DeepSeek", "fake-key", true);
        expect(confirmation).toBe("DeepSeek key works");
        const html = renderToStaticMarkup(createElement("section", null,
            createElement(KeySaveConfirmation, { message: confirmation! }),
            createElement(ModelStep, { models, model: "deepseek-v4-pro", query: "", onModelChange: () => undefined, onQueryChange: () => undefined }),
        ));
        expect(html).toContain('<p class="provider-wizard-success" role="status">DeepSeek key works</p>');
        expect(html).toContain("DeepSeek V4 Pro");
        expect(html).toContain("DeepSeek V4.1 Flash 1017");
        expect(html).toContain("$0.1 / $0.3");
    });

    test("keyless saves and unsuccessful replacements have no confirmation", () => {
        expect(keySaveConfirmation("DeepSeek", "", true)).toBeUndefined();
        expect(keySaveConfirmation("DeepSeek", "fake-key", false)).toBeUndefined();
        expect(keySaveConfirmation("DeepSeek", "   ", true)).toBeUndefined();
    });

    test("initial render opens a supplied provider directly and waits for an id-only open", () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
        try {
            const supplied = renderToStaticMarkup(createElement(ProviderWizard, { onClose: () => undefined, initialProviderStatus: providers[0] }));
            expect(supplied).toContain("Connect DeepSeek");
            expect(supplied).toContain("DeepSeek API key");
            expect(supplied).not.toContain("Connect a provider");
            expect(supplied).not.toContain("Search providers");
            const idOnly = renderToStaticMarkup(createElement(ProviderWizard, { onClose: () => undefined, initialProvider: "deepseek" }));
            expect(idOnly).toBe("");
            const withoutProvider = renderToStaticMarkup(createElement(ProviderWizard, { onClose: () => undefined }));
            expect(withoutProvider).toBe("");
        } finally {
            if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
            else Object.defineProperty(globalThis, "window", previous);
        }
    });

    test("provider list shows key and local connection methods and custom row", () => {
        const html = renderToStaticMarkup(createElement(ProviderStep, { providers, runningProvider: "custom", query: "", onChoose: () => undefined, onCustom: () => undefined }));
        expect(html).toContain("Connected");
        expect(html).toContain("Add a provider");
        expect(html).toContain("DeepSeek");
        expect(html).toContain("Key");
        expect(html).toContain("Local endpoint");
        expect(html).toContain("Local");
        expect(html).not.toContain("localhost:11434");
        expect(html).toContain("localhost:8080");
        expect(html).toContain('class="provider-card-label">In use</span>');
        expect(html).not.toContain("provider-wizard-provider-icon");
        expect(html).not.toContain("›");
        expect(html).toContain("Custom provider");
        const filtered = renderToStaticMarkup(createElement(ProviderStep, { providers, query: "deep", onChoose: () => undefined, onCustom: () => undefined }));
        expect(filtered).toContain("DeepSeek");
        expect(filtered).not.toContain("Local endpoint");
    });

    test("provider key screen uses the provider-specific label and environment state", () => {
        const common = { custom: false, id: "deepseek", endpoint: "", apiKey: "", replacing: false, busy: false, onIdChange: () => undefined, onEndpointChange: () => undefined, onKeyChange: () => undefined, onReplace: () => undefined };
        const keyScreen = renderToStaticMarkup(createElement(KeyStep, { ...common, provider: providers[0] }));
        expect(keyScreen).not.toContain("<h3>");
        expect(keyScreen).toContain("Enter your DeepSeek API key.");
        expect(keyScreen).toContain('aria-label="DeepSeek API key"');
        const environment = renderToStaticMarkup(createElement(KeyStep, { ...common, provider: { ...providers[0]!, connected: true, connected_by: "environment" } }));
        expect(environment).toContain("Provided by the environment");
        expect(environment).not.toContain("Stored in Vera");
    });

    test("key echo never repeats a short key and only previews a long-key prefix", () => {
        const common = { custom: false, id: "deepseek", endpoint: "", replacing: true, busy: false, onIdChange: () => undefined, onEndpointChange: () => undefined, onKeyChange: () => undefined, onReplace: () => undefined };
        expect(keyEcho("abc")).toBe("3 characters");
        expect(keyEcho("abcdef")).toBe("6 characters");
        expect(keyEcho("sk-123456-secret")).toBe("16 characters, starting sk-123…");
        const unfocused = renderToStaticMarkup(createElement(KeyStep, { ...common, apiKey: "sk-123456-secret" }));
        expect(unfocused).not.toContain("provider-wizard-key-echo");
    });

    test("key actions submit the form for connect, sign in, and stored keys", () => {
        const common = { step: "key" as const, replacing: false, busy: false, id: "deepseek", apiKey: "fake-key", model: "" };
        const connect = renderToStaticMarkup(createElement(ProviderWizardFooter, { ...common, provider: providers[0] }));
        expect(connect).toContain('type="submit"');
        expect(connect).toContain(">Continue</button>");
        const browser = renderToStaticMarkup(createElement(ProviderWizardFooter, { ...common, provider: { ...providers[0]!, methods: ["browser"] } }));
        expect(browser).toContain(">Sign in</button>");
        const stored = renderToStaticMarkup(createElement(ProviderWizardFooter, { ...common, provider: { ...providers[0]!, connected: true } }));
        expect(stored).toContain(">Continue</button>");
        const modelAction = renderToStaticMarkup(createElement(ProviderWizardFooter, { ...common, step: "model", model: "deepseek-v4-pro" }));
        expect(modelAction).toContain('type="submit"');
        expect(modelAction).toContain(">Check and use</button>");
    });

    test("model search and rows show available model metadata", () => {
        const html = renderToStaticMarkup(createElement(ModelStep, {
            models,
            model: "deepseek-v4-pro",
            query: "flash",
            onModelChange: () => undefined,
            onQueryChange: () => undefined,
        }));
        expect(html).toContain("aria-label=\"Search models\"");
        expect(html).toContain('placeholder="Search models"');
        expect(html).not.toContain("visually-hidden");
        expect(html).toContain("DeepSeek V4.1 Flash 1017");
        expect(html).toContain("$0.1 / $0.3");
        expect(html).not.toContain("DeepSeek V4 Pro");
        expect(models.map((entry) => entry.model)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
        expect(models.map((entry) => entry.levels.map((level) => level.id))).toEqual([["max", "high", "off"], ["max", "high", "off"]]);
        expect(models.map((entry) => entry.defaultLevel)).toEqual(["high", "high"]);
        expect(models.find((entry) => entry.recommended)?.model).toBe("deepseek-v4-pro");
    });
});
