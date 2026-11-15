import type { ProviderListAnswer } from "../../host/provider-sign-in-client.ts";
import type { HostExtensionLoadFailure } from "../../host/extension-load-failures-client.ts";

export const MAX_LISTED_ROWS = 50;
const MAX_MESSAGE_CHARACTERS = 300;

const HOW_CONNECTED = {
    key: " with a key",
    browser: " by signing in",
    environment: " from an environment variable",
    none: "",
} as const;

export function describeProviders(answer: ProviderListAnswer): string {
    const rows = answer.providers.slice(0, MAX_LISTED_ROWS).map((provider) =>
        `${provider.name} (${provider.id}): ${provider.connected
            ? `connected${HOW_CONNECTED[provider.connected_by ?? "none"]}`
            : "not connected"}`);
    return [
        ...(answer.needsSetup ? ["No provider is connected yet."] : []),
        ...rows,
        ...(answer.providers.length > MAX_LISTED_ROWS
            ? [`${answer.providers.length - MAX_LISTED_ROWS} more are not listed.`]
            : []),
    ].join("\n");
}

export function describeExtensionFailures(failures: readonly HostExtensionLoadFailure[]): string {
    if (failures.length === 0) return "No extension failed to load.";
    return [
        ...failures.slice(0, MAX_LISTED_ROWS).map((failure) =>
            `${failure.extensionId}: ${failure.message.slice(0, MAX_MESSAGE_CHARACTERS)}`),
        ...(failures.length > MAX_LISTED_ROWS
            ? [`${failures.length - MAX_LISTED_ROWS} more are not listed.`]
            : []),
    ].join("\n");
}

// Both reads go to the host that owns this home, the way the clients ask it.
export async function readProviders(): Promise<string> {
    const [{ listProvidersThroughHost }, { defaultHostSocketPath }] = await Promise.all([
        import("../../host/provider-sign-in-client.ts"),
        import("../../host/lockfile.ts"),
    ]);
    return describeProviders(await listProvidersThroughHost(defaultHostSocketPath()));
}

export async function readExtensionFailures(): Promise<string> {
    const [{ readExtensionLoadFailuresThroughHost }, { defaultHostSocketPath }] = await Promise.all([
        import("../../host/extension-load-failures-client.ts"),
        import("../../host/lockfile.ts"),
    ]);
    return describeExtensionFailures(await readExtensionLoadFailuresThroughHost(defaultHostSocketPath()));
}
