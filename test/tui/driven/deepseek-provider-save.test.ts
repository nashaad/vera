import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { startingVeraConfig } from "../../../src/config.ts";
import { createAuthStorage } from "../../../src/providers/auth-storage.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import type { AvailableModel } from "../../../src/model/catalog-view.ts";
import { deepSeekCatalogModels } from "../../../src/model/deepseek-catalog.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { emptyUsage, type AssistantMessage } from "../../../src/model/types.ts";

const deepSeekModels: readonly AvailableModel[] = deepSeekCatalogModels().map(
    (model) => ({
        provider: "deepseek",
        model: model.id,
        label: model.label,
        description: model.description ?? "",
        refreshable: false,
        levels: model.levels,
        defaultLevel: model.default_level,
    }),
);

test("@core Settings key save shows DeepSeek confirmation and bundled models", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-deepseek-save-"));
    const authStorage = createAuthStorage({ path: join(home, "machine", "auth.json") });
    const commands: ClientCommand[] = [];
    let availableModels: readonly AvailableModel[] = [];
    const starter = startingVeraConfig();
    let selectedProvider = starter.provider;
    let selectedModel = starter.model;
    let reasoningEffort: string | undefined;
    const settings = () => ({
        provider: selectedProvider,
        model: selectedModel,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        availableModels,
        refreshableProviders: [],
    });
    const channel = createInProcessChannel();
    let settingsUpdates = 0;
    let releaseFreshSettings = () => {};
    const freshSettingsHeld = new Promise<void>((resolve) => {
        releaseFreshSettings = resolve;
    });
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "fixture response" }],
        source: {
            provider: "openrouter",
            api: "openai-chat-completions",
            model: "test/model",
        },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([response], { chunkSize: 1 }),
        "test/model",
        undefined,
        { approvalMode: "auto" },
        {
            readModelSettings: settings,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => "auto",
            router: {
                poolAdd: async () => ({ verdict: "added" }),
                updateModelSettings: async (patch) => {
                    selectedProvider = patch.provider ?? selectedProvider;
                    selectedModel = patch.model ?? selectedModel;
                    reasoningEffort = patch.reasoningEffort ?? undefined;
                    return settings();
                },
            },
        },
    );
    const dependencies: TuiDependencies = {
        authStorage,
        client: {
            async send(command): Promise<void> {
                commands.push(command);
                channel.client.send(command);
            },
            async receive(signal) {
                const update = await channel.client.receive(signal);
                if (update.type === "model_settings") {
                    settingsUpdates += 1;
                    if (settingsUpdates === 2) await freshSettingsHeld;
                }
                return update;
            },
            async detach(): Promise<void> {},
            close(): void {},
        },
        saveProviderKey: async (provider, key) => {
            expect(provider).toBe("deepseek");
            expect(key).toBe("test-deepseek-key");
            authStorage.setCredential(provider, { type: "api_key", key });
            availableModels = deepSeekModels;
        },
    };
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 36,
        providerKey: false,
        dependencies: () => dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("configure providers");
        await session.waitForVisiblePane("Configure providers");
        session.sendKey("Enter");
        await session.waitForVisiblePane("API keys");
        session.sendText("deepseek");
        await session.settle();
        session.sendKey("Enter");
        await session.waitForVisiblePane("Set this provider up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("API key");
        session.sendText("test-deepseek-key");
        session.sendKey("Enter");

        await session.waitForVisiblePaneWhere(
            () => settingsUpdates === 2,
            "the post-save model settings request",
        );
        const whileSettingsArePending = session.captureVisiblePane();
        expect(whileSettingsArePending).not.toContain("DeepSeek listed no models");
        expect(whileSettingsArePending).not.toContain("DeepSeek V4 Pro");
        releaseFreshSettings();
        const confirmation = await session.waitForVisiblePane("DeepSeek key works");
        expect(confirmation).toContain("DeepSeek key works");
        await session.waitForVisiblePane("DeepSeek V4 Pro");
        await session.waitForVisiblePane("DeepSeek V4.1 Flash 1017");
        const afterSave = session.captureVisiblePane();
        expect(afterSave).not.toContain("Asking DeepSeek");
        expect(afterSave).not.toContain("DeepSeek listed no models");
        expect(commands.some((command) => command.type === "catalog_refresh")).toBe(false);

        session.sendKey("Enter");
        await session.waitForVisiblePane("Connected.");
        await session.waitForVisiblePaneWhere(
            () => commands.some((command) => command.type === "update_model_settings"),
            "the selected model settings command",
        );
        const change = commands.find((command) => command.type === "update_model_settings");
        expect(change).toMatchObject({
            type: "update_model_settings",
            patch: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" },
        });
        session.sendKey("Enter");
        await session.waitForVisiblePane("high");
        expect(commands.some((command) => command.type === "catalog_refresh")).toBe(false);
    } finally {
        releaseFreshSettings();
        await session.close();
    }
}, 20_000);
