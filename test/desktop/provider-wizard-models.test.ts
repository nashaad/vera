import { expect, test } from "bun:test";

import { loadProviderModels } from "../../clients/ui/src/pages/settings/provider-wizard/load-models.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";

const models = {
    provider: "deepseek",
    model: "deepseek-chat",
    availableModels: [
        { provider: "deepseek", model: "deepseek-chat" },
        { provider: "deepseek", model: "deepseek-reasoner" },
    ],
};

test("fixed provider models are shown without a refresh request", async () => {
    let refreshes = 0;
    const bridge: Pick<DesktopBridge, "readModelSettings" | "refreshCatalog"> = {
        readModelSettings: async () => ({ ok: true, settings: { ...models, refreshableProviders: [] } }),
        refreshCatalog: async () => {
            refreshes += 1;
            return { ok: false, reason: "The provider could not be asked for its models." };
        },
    };
    const result = await loadProviderModels(bridge, "deepseek");
    expect(result.rows.map((row) => row.model)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(result.failure).toBeUndefined();
    expect(refreshes).toBe(0);
});

test("a failed or malformed refresh retains the stored catalog and reports the failure", async () => {
    for (const response of [
        { ok: false as const, reason: "The provider could not be asked for its models." },
        { ok: true as const, settings: {} },
    ]) {
        const bridge: Pick<DesktopBridge, "readModelSettings" | "refreshCatalog"> = {
            readModelSettings: async () => ({ ok: true, settings: { ...models, refreshableProviders: ["deepseek"] } }),
            refreshCatalog: async () => response,
        };
        const result = await loadProviderModels(bridge, "deepseek");
        expect(result.rows.map((row) => row.model)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
        expect(result.failure).toBeDefined();
    }
});
