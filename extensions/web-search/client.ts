import type { VeraClientExtensionApi, VeraClientPickerRow } from "../../src/sdk/extensions.ts";
import { PROVIDER_NAMES, SEARCH_PROVIDERS, type SearchProvider } from "./providers.ts";
import { SearchStore } from "./store.ts";
import { searchWeb } from "./search.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    const store = new SearchStore(vera.storage.profile, undefined, undefined, vera.config);
    vera.commands.register({
        name: "search-providers",
        description: "Configure web search providers, keys, and fallback order",
        usage: "/search-providers",
        palette: { label: "Search providers", group: "Settings" },
        interactive: true,
        async run({ signal }) {
            await openSearchProviders(vera, store, signal);
            return { kind: "handled" };
        },
    });
}

export async function openSearchProviders(vera: VeraClientExtensionApi, store: SearchStore, signal: AbortSignal): Promise<void> {
    const pick = async (title: string, rows: readonly VeraClientPickerRow[], subtitle?: string, selectedId?: string): Promise<string | undefined> => {
        const result = await vera.ui.requestPicker({ title, rows, subtitle, selectedId, searchable: false, layout: "menu",
            actions: [{ id: "open", label: "open", keys: ["enter"] }] }, signal);
        return result.outcome === "selected" ? result.rowId : undefined;
    };
    let notice = "Search tries enabled providers from top to bottom.";
    let selected: string | undefined;
    while (!signal.aborted) {
        const providers = store.providers();
        const result = await vera.ui.requestPicker({
            title: "Search providers", layout: "list-detail", searchable: false,
            subtitle: notice, selectedId: providers.some((entry) => entry.id === selected) ? selected : undefined,
            rows: providers.length ? providers.map((entry, index) => ({
                id: entry.id, label: PROVIDER_NAMES[entry.id], meta: entry.enabled ? "Enabled" : "Disabled",
                details: [PROVIDER_NAMES[entry.id], "", `Status: ${entry.enabled ? "Enabled" : "Disabled"}`,
                    `Key: ${store.credentialSource(entry.id)}`, `Fallback position: ${index + 1}`],
            })) : [{ id: "empty", label: "No providers connected", details: ["Choose Connect provider below."] }],
            actions: [
                { id: "open", label: "manage provider", keys: ["enter"] },
                { id: "connect", label: "Connect provider", keys: ["enter"], button: true },
            ],
        }, signal);
        if (result.outcome !== "selected") return;
        const chosen = result.actionId === "connect" || result.rowId === "empty" ? "add" : result.rowId;
        selected = result.rowId;
        try {
            if (chosen === "add") {
                const available = SEARCH_PROVIDERS.filter((id) => !providers.some((entry) => entry.id === id));
                if (!available.length) { notice = "All supported providers are already added."; continue; }
                const id = await pick("Connect search provider", available.map((id) => ({ id, label: PROVIDER_NAMES[id] })),
                    available.length ? "Choose a search service." : "All supported providers are already added.");
                if (!id) continue;
                const provider = id as SearchProvider;
                if (provider !== "duckduckgo" && !store.key(provider)) {
                    const key = await vera.experimentalTui.requestSecret({ title: `${PROVIDER_NAMES[provider]} API key`, hint: "Stored in this Vera home's credential store." }, signal);
                    if (key === undefined) continue;
                    store.saveKey(provider, key);
                }
                store.save([...providers, { id: provider, enabled: true }]);
                selected = provider;
                notice = `${PROVIDER_NAMES[provider]} added. Changes apply to the next search.`;
                continue;
            }
            const provider = chosen as SearchProvider;
            let action: string | undefined;
            do {
                const current = store.providers();
                const index = current.findIndex((entry) => entry.id === provider);
                const entry = current[index];
                if (!entry) break;
                action = await pick(`Manage ${PROVIDER_NAMES[provider]}`, [
                    ...(provider === "duckduckgo" ? [] : [{ id: "key", label: "Set API key", group: "credentials" }]),
                    { id: "verify", label: "Verify", group: "credentials", details: ["Runs one search for “Vera search test”.", ...(provider === "duckduckgo" ? [] : ["API charges may apply."])] },
                    ...(provider === "duckduckgo" ? [] : [{ id: "remove-key", label: "Remove saved key", group: "credentials" }]),
                    ...(index > 0 ? [{ id: "up", label: "Move up", group: "order" }] : []),
                    ...(index < current.length - 1 ? [{ id: "down", label: "Move down", group: "order" }] : []),
                    { id: "toggle", label: entry.enabled ? "Disable" : "Enable", group: "state" },
                    { id: "remove", label: "Remove provider", group: "state" },
                ], `${store.credentialSource(provider)}. ${notice}`);
                if (!action) break;
                if (action === "key") {
                    const key = await vera.experimentalTui.requestSecret({ title: `${PROVIDER_NAMES[provider]} API key`, hint: "Leave empty and press Escape to keep the current key." }, signal);
                    if (key !== undefined) { store.saveKey(provider, key); notice = "API key saved."; }
                } else if (action === "remove-key") {
                    store.removeKey(provider); notice = "Saved key removed. An exported environment key still applies.";
                } else if (action === "verify") {
                    notice = await verifyProvider(vera, store, provider, signal);
                } else {
                    const updated = current.map((item) => ({ ...item }));
                    if (action === "toggle") updated[index]!.enabled = !entry.enabled;
                    if (action === "remove") updated.splice(index, 1);
                    if (action === "up" || action === "down") {
                        const other = index + (action === "up" ? -1 : 1);
                        [updated[index], updated[other]] = [updated[other]!, updated[index]!];
                    }
                    store.save(updated);
                    notice = "Saved. Changes apply to the next search.";
                    if (action === "remove") { selected = undefined; break; }
                }
            } while (!signal.aborted);
        } catch (error) {
            if (signal.aborted) return;
            notice = error instanceof Error ? error.message : "Could not update search providers.";
        }
    }
}

async function verifyProvider(vera: VeraClientExtensionApi, store: SearchStore, provider: SearchProvider, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let notice = "Verification cancelled.";
    const pending = vera.ui.requestPicker({ title: `Verify ${PROVIDER_NAMES[provider]}`, subtitle: "Searching… Escape cancels.",
        rows: [{ id: "cancel", label: "Cancel verification" }], searchable: false, actions: [{ id: "cancel", label: "cancel", keys: ["enter"] }] }, AbortSignal.any([signal, controller.signal]));
    const work = searchWeb("Vera search test", 1, [{ id: provider, enabled: true }], (id) => store.key(id), AbortSignal.any([signal, controller.signal]), { attemptTimeoutMs: 15_000 })
        .then((result) => { notice = `Verified. ${result.results.length} result(s) returned.`; },
            (error) => { if (!controller.signal.aborted) notice = error instanceof Error ? error.message : "Verification failed."; });
    try { await Promise.race([pending.catch(() => undefined), work]); }
    finally { controller.abort(); await Promise.allSettled([pending, work]); }
    return notice;
}
