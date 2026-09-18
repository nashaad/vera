import type { JsonValue } from "../../sdk/hooks.ts";
import type { VeraClientExtensionApi, VeraClientPickerRow, VeraSearchProviderInfo } from "../../sdk/extensions.ts";
import { isBuiltIn, SearchStore } from "./store.ts";
import { NO_PROVIDER_HINT } from "./search.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    let registered: readonly VeraSearchProviderInfo[] = [];
    const store = new SearchStore(vera.storage.profile, () => registered, undefined, undefined, vera.config);
    vera.commands.register({
        name: "search-providers",
        description: "Configure web search providers, keys, and fallback order",
        usage: "/search-providers",
        palette: { label: "Search providers", group: "Settings" },
        interactive: true,
        async run({ signal }) {
            registered = parseProviders(await vera.host.request("providers", null, signal));
            await openSearchProviders(vera, store, signal);
            return { kind: "handled" };
        },
    });
}

export async function openSearchProviders(vera: VeraClientExtensionApi, store: SearchStore<VeraSearchProviderInfo>, signal: AbortSignal): Promise<void> {
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
            subtitle: notice, selectedId: providers.some((entry) => entry.provider.id === selected) ? selected : undefined,
            rows: providers.length ? providers.map((entry, index) => ({
                id: entry.provider.id, label: entry.provider.label, meta: entry.enabled ? "Enabled" : "Disabled",
                details: [entry.provider.label, "", `Status: ${entry.enabled ? "Enabled" : "Disabled"}`,
                    `Key: ${store.credentialSource(entry.provider)}`, `Fallback position: ${index + 1}`],
            })) : [{ id: "empty", label: "No providers connected", details: [NO_PROVIDER_HINT] }],
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
                const available = store.available();
                if (!available.length) { notice = "All supported providers are already added."; continue; }
                const id = await pick("Connect search provider", available.map((provider) => ({ id: provider.id, label: provider.label })),
                    "Choose a search service.");
                const provider = available.find((entry) => entry.id === id);
                if (!provider) continue;
                if (provider.requiresKey && !store.key(provider)) {
                    const key = await vera.experimentalTui.requestSecret({ title: `${provider.label} API key`, hint: "Stored in this Vera home's credential store." }, signal);
                    if (key === undefined) continue;
                    store.saveKey(provider, key);
                }
                store.save([...providers, { provider, enabled: true }]);
                selected = provider.id;
                notice = `${provider.label} added. Changes apply to the next search.`;
                continue;
            }
            const provider = providers.find((entry) => entry.provider.id === chosen)?.provider;
            if (!provider) continue;
            const keyed = provider.requiresKey || provider.keyEnv !== undefined;
            let action: string | undefined;
            do {
                const current = store.providers();
                const index = current.findIndex((entry) => entry.provider.id === provider.id);
                const entry = current[index];
                if (!entry) break;
                action = await pick(`Manage ${provider.label}`, [
                    ...(keyed ? [{ id: "key", label: "Set API key", group: "credentials" }] : []),
                    { id: "verify", label: "Verify", group: "credentials", details: ["Runs one search for “Vera search test”.", ...(keyed ? ["API charges may apply."] : [])] },
                    ...(keyed ? [{ id: "remove-key", label: "Remove saved key", group: "credentials" }] : []),
                    ...(index > 0 ? [{ id: "up", label: "Move up", group: "order" }] : []),
                    ...(index < current.length - 1 ? [{ id: "down", label: "Move down", group: "order" }] : []),
                    { id: "toggle", label: entry.enabled ? "Disable" : "Enable", group: "state" },
                    ...(isBuiltIn(provider.id) ? [{ id: "remove", label: "Remove provider", group: "state" }] : []),
                ], `${store.credentialSource(provider)}. ${notice}`);
                if (!action) break;
                if (action === "key") {
                    const key = await vera.experimentalTui.requestSecret({ title: `${provider.label} API key`, hint: "Leave empty and press Escape to keep the current key." }, signal);
                    if (key !== undefined) { store.saveKey(provider, key); notice = "API key saved."; }
                } else if (action === "remove-key") {
                    store.removeKey(provider); notice = "Saved key removed. An exported environment key still applies.";
                } else if (action === "verify") {
                    notice = await verifyProvider(vera, provider, signal);
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

async function verifyProvider(vera: VeraClientExtensionApi, provider: VeraSearchProviderInfo, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let notice = "Verification cancelled.";
    const pending = vera.ui.requestPicker({ title: `Verify ${provider.label}`, subtitle: "Searching… Escape cancels.",
        rows: [{ id: "cancel", label: "Cancel verification" }], searchable: false, actions: [{ id: "cancel", label: "cancel", keys: ["enter"] }] }, AbortSignal.any([signal, controller.signal]));
    const work = vera.host.request("verify", { id: provider.id }, AbortSignal.any([signal, controller.signal]))
        .then((result) => { notice = `Verified. ${resultCount(result)} result(s) returned.`; },
            (error) => { if (!controller.signal.aborted) notice = error instanceof Error ? error.message : "Verification failed."; });
    try { await Promise.race([pending.catch(() => undefined), work]); }
    finally { controller.abort(); await Promise.allSettled([pending, work]); }
    return notice;
}

function parseProviders(value: JsonValue): readonly VeraSearchProviderInfo[] {
    if (!Array.isArray(value)) throw new Error("The host returned an invalid search provider list.");
    return value.flatMap((entry): VeraSearchProviderInfo[] => {
        if (entry === null || typeof entry !== "object") return [];
        const { id, label, requiresKey, keyEnv } = entry as Record<string, unknown>;
        if (typeof id !== "string" || typeof label !== "string" || typeof requiresKey !== "boolean") return [];
        return [{ id, label, requiresKey, ...(typeof keyEnv === "string" ? { keyEnv } : {}) }];
    });
}

function resultCount(value: JsonValue): number {
    const count = value !== null && typeof value === "object" ? (value as { count?: unknown }).count : undefined;
    return typeof count === "number" ? count : 0;
}
