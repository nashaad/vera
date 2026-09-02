import { expect, test } from "bun:test";

import { createHomeClient } from "../../clients/tui/home-client.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";

const SETTINGS: ModelTurnSettings = {
    provider: "outrider",
    model: "qwen35-9b-provisional",
    availableModels: [{
        provider: "outrider",
        model: "qwen35-9b-provisional",
        label: "qwen35-9b-provisional",
        description: "",
        refreshable: true,
        levels: [],
    }],
    refreshableProviders: ["outrider"],
};

test("home catalog refresh asks the host and publishes the new listing", async () => {
    const asked: string[] = [];
    const client = createHomeClient("/work/vera", {
        refreshCatalog: async (provider, workspace) => {
            asked.push(`${provider}:${workspace}`);
            return SETTINGS;
        },
    });
    try {
        await client.send({
            type: "catalog_refresh",
            requestId: "refresh-1",
            provider: "outrider",
        });
        expect(await client.receive()).toMatchObject({ type: "history" });
        const update = await client.receive();
        expect(asked).toEqual(["outrider:/work/vera"]);
        expect(update).toMatchObject({
            type: "model_settings",
            requestId: "refresh-1",
            settings: SETTINGS,
            pending: false,
        });
    } finally {
        client.close();
    }
});

test("home catalog refresh without a host path is a rejection, not a silent drop", async () => {
    const client = createHomeClient("/work/vera");
    try {
        await client.send({
            type: "catalog_refresh",
            requestId: "refresh-2",
            provider: "outrider",
        });
        expect(await client.receive()).toMatchObject({ type: "history" });
        expect(await client.receive()).toMatchObject({
            type: "model_settings_rejected",
            requestId: "refresh-2",
            reason: "unavailable",
        });
    } finally {
        client.close();
    }
});
