import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { ProviderWizard } from "../../ui/src/pages/settings/ProviderWizard.tsx";
import type { ProviderStatus } from "../../ui/src/protocol/bridge.ts";

const provider: ProviderStatus = { id: "deepseek", name: "DeepSeek", methods: ["key"], connected: false, catalog_connected: false, enabled: true, custom: false };
let resolveList: ((result: unknown) => void) | undefined;
const bridge = {
    readModelSettings: async () => ({ ok: false, reason: "unavailable" }),
    listProviders: () => new Promise((resolve) => { resolveList = resolve; }),
    cancelProviderSignIn: () => undefined,
};
Object.assign(window, { veraDesktop: bridge });
const root = createRoot(document.getElementById("root")!);
Object.assign(window, {
    openIdOnly: () => flushSync(() => root.render(createElement(ProviderWizard, { key: "id", onClose: () => undefined, initialProvider: provider.id }))),
    openSeeded: (key: string) => flushSync(() => root.render(createElement(ProviderWizard, { key, onClose: () => undefined, initialProviderStatus: provider }))),
    openWithoutProvider: () => flushSync(() => root.render(createElement(ProviderWizard, { key: "none", onClose: () => undefined }))),
    resolveProviders: (connected = false) => resolveList?.({ ok: true, providers: [{ ...provider, connected, connected_by: connected ? "key" : undefined }] }),
    failProviders: () => resolveList?.({ ok: false, reason: "unavailable" }),
});
