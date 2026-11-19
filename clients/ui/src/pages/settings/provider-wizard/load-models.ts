import { parseModelSettings, type ModelEntry, type ModelSettings } from "../../../models/settings.ts";
import type { DesktopBridge } from "../../../protocol/bridge.ts";

interface ProviderModels {
    readonly rows: readonly ModelEntry[];
    readonly settings?: ModelSettings;
    readonly failure?: string;
}

export async function loadProviderModels(
    bridge: Pick<DesktopBridge, "readModelSettings" | "refreshCatalog">,
    provider: string,
): Promise<ProviderModels> {
    const stored = await bridge.readModelSettings();
    const settings = stored.ok ? parseModelSettings(stored.settings) : undefined;
    let rows = settings?.catalog.filter((entry) => entry.provider === provider) ?? [];
    let failure = stored.ok ? undefined : stored.reason;
    if (settings?.refreshableProviders?.includes(provider) === true) {
        try {
            const refreshed = await bridge.refreshCatalog(provider);
            if (refreshed.ok) {
                const updated = parseModelSettings(refreshed.settings);
                if (updated === undefined) failure = "The host did not list its models.";
                else rows = updated.catalog.filter((entry) => entry.provider === provider);
            } else {
                failure = refreshed.reason;
            }
        } catch {
            failure = "The provider could not be asked for its models.";
        }
    }
    return { rows, ...(settings === undefined ? {} : { settings }), ...(failure === undefined ? {} : { failure }) };
}
