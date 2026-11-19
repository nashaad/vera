import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import { ProviderCards, ProviderForgetConfirmation } from "../../clients/ui/src/pages/settings/ProviderCards.tsx";
import type { DesktopBridge, ProviderStatus } from "../../clients/ui/src/protocol/bridge.ts";

const providers: readonly ProviderStatus[] = [
    { id: "anthropic", name: "Anthropic", methods: ["key"], connected: true, catalog_connected: true, connected_by: "key", custom: false },
    { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: false, catalog_connected: false, custom: false },
    { id: "browser", name: "BrowserCo", methods: ["browser"], connected: true, catalog_connected: true, connected_by: "browser", custom: false },
    { id: "signin", name: "SignInCo", methods: ["browser"], connected: false, catalog_connected: false, custom: false },
    { id: "env", name: "EnvCo", methods: ["key"], connected: true, catalog_connected: true, connected_by: "environment", custom: false },
    { id: "local", name: "Local", methods: [], connected: false, catalog_connected: false, custom: false },
    { id: "custom", name: "Custom Endpoint", methods: ["key"], connected: true, catalog_connected: true, connected_by: "key", custom: true, endpoint: "https://api.example.test/v1" },
    { id: "unknown", name: "UnknownCo", methods: ["key"], connected: true, catalog_connected: true, custom: false },
];

function renderCards(): string {
    return renderToStaticMarkup(createElement(ProviderCards, {
        bridge: {} as DesktopBridge,
        providers,
        runningProvider: "anthropic",
        onConnect: () => undefined,
        onCustom: () => undefined,
        onReload: () => undefined,
    }));
}

describe("Settings provider cards", () => {
    test("shows connected rows and the host-reported method labels", () => {
        const html = renderCards();
        expect(html).toContain("Anthropic");
        expect(html).toContain("Stored key");
        expect(html).toContain("Signed in");
        expect(html).toContain("Environment");
        expect(html).toContain("Custom");
        expect(html).toContain("UnknownCo</span><span class=\"provider-card-label\">Connected</span>");
        expect(html).toContain('<span class="provider-card-label">Custom</span>');
        expect(html).toContain("api.example.test");
        expect(html).toContain('<span class="provider-card-label">In use</span>');
        expect(html).not.toContain("provider-card-icon");
        expect(html).toContain("role=\"group\" aria-label=\"Anthropic\"");
    });

    test("shows add-row method labels and custom provider copy", () => {
        const html = renderCards();
        expect(html).toContain("DeepSeek");
        expect(html).toContain(">Key</span>");
        expect(html).toContain("SignInCo</span><span class=\"provider-card-label\">Sign in</span>");
        expect(html).toContain(">Local</span>");
        expect(html).toContain("Custom provider");
        expect(html).toContain("Any OpenAI-compatible endpoint by its base URL.");
        expect(html).toContain("Connect");
    });

    test("renders the existing inline Forget confirmation actions", () => {
        const html = renderToStaticMarkup(createElement(ProviderForgetConfirmation, {
            name: "Anthropic",
            busy: false,
            onForget: () => undefined,
            onCancel: () => undefined,
        }));
        expect(html).toContain("Forget Anthropic?");
        expect(html).toContain("saved connection and what it learned about its models");
        expect(html).toContain(">Forget</button>");
        expect(html).toContain(">Cancel</button>");
    });
});
