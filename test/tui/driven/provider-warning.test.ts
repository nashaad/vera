import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

const WARNING = "OpenRouter is on, but its model list could not be refreshed. The saved list stands.";

test("@core turning a provider on shows the host's refresh warning", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-provider-warning-"));
    const configPath = join(home, ".vera", "config.json");
    mkdirSync(join(home, ".vera"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        disabled_providers: ["openrouter"],
    }));

    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 36,
        dependencies: () => ({
            ...createTuiCatalogRefreshDependencies(),
            authStorage: {
                getCredential: (id: string) => id === "openrouter"
                    ? { type: "api_key" as const, key: "fixture" }
                    : undefined,
                setCredential() {},
                deleteCredential() {},
            },
            setProviderEnabled: async (provider, enabled) => {
                writeFileSync(configPath, JSON.stringify({
                    schema_version: 1,
                    provider: "openai-codex",
                    model: "gpt-5.6-sol",
                    ...(enabled ? {} : { disabled_providers: [provider] }),
                }));
                return enabled ? { warning: WARNING } : {};
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("configure providers");
        await session.waitForVisiblePane("Configure providers");
        session.sendKey("Enter");
        await session.waitForVisiblePane("API keys");
        session.sendText("openrouter");
        await session.settle();
        session.sendKey("Enter");
        await session.waitForVisiblePane("Use it again and read its models");
        // Connect and Edit sit above Turn on until the provider has answered.
        session.sendKey("Down");
        session.sendKey("Down");
        await session.settle();
        session.sendKey("Enter");

        const pane = await session.waitForVisiblePane(WARNING);
        expect(pane).toContain("Configure providers");

        session.sendKey("Escape");
        const transcript = await session.waitForVisiblePane("Turned OpenRouter on.");
        expect(transcript).toContain(WARNING);
    } finally {
        await session.close();
    }
}, 15_000);
