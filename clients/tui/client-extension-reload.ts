import type { VeraExtensionConfig } from "../../src/config.ts";
import type { ClientExtensionRegistry } from
    "../../src/extensions/client-registry.ts";
import {
    configuredTuiClientExtensions,
    type TuiClientExtensionHostController,
} from "./client-extension-host.ts";

export interface TuiClientExtensionReloadConfiguration {
    readonly disabledBuiltinExtensions: readonly string[];
    readonly clientExtensions: readonly VeraExtensionConfig[];
}

export interface ReloadTuiClientExtensionsOptions {
    readonly configuration: TuiClientExtensionReloadConfiguration;
    readonly refreshConfiguration?: () => TuiClientExtensionReloadConfiguration;
    readonly applyConfiguration: (
        configuration: TuiClientExtensionReloadConfiguration,
    ) => void;
    readonly host: TuiClientExtensionHostController;
    readonly start: (
        signal: AbortSignal,
        extensions: readonly VeraExtensionConfig[],
        failures: string[],
    ) => Promise<ClientExtensionRegistry>;
}

/** Details from a client-extension generation that activated incompletely. */
export class ClientExtensionReloadPartialFailure extends Error {
    readonly kind: "none" | "some";
    readonly loadedExtensionIds: readonly string[];
    readonly failures: readonly string[];

    constructor(
        kind: "none" | "some",
        details: string,
        loadedExtensionIds: readonly string[],
        failures: readonly string[],
    ) {
        super(details);
        this.name = "ClientExtensionReloadPartialFailure";
        this.kind = kind;
        this.loadedExtensionIds = loadedExtensionIds;
        this.failures = failures;
    }
}

/** Keep extension failures useful in a notice and bounded in the transcript. */
export function boundedExtensionReloadFailure(message: string): string {
    const compact = message.replaceAll(/\s+/g, " ").trim();
    return compact.length <= 240
        ? compact
        : `${compact.slice(0, 239).trimEnd()}…`;
}

/** Reload one client generation while keeping the TUI's displayed config truthful. */
export async function reloadTuiClientExtensions(
    options: ReloadTuiClientExtensionsOptions,
): Promise<readonly string[]> {
    const refreshed = options.refreshConfiguration?.();
    const nextConfiguration = refreshed === undefined
        ? options.configuration
        : {
            disabledBuiltinExtensions: refreshed.disabledBuiltinExtensions,
            clientExtensions: configuredTuiClientExtensions(
                refreshed.disabledBuiltinExtensions,
                refreshed.clientExtensions,
            ),
        };
    const failures: string[] = [];

    // Apply before activation so diagnostics names the generation being tested
    // even when activation fails after the old generation is disposed.
    options.applyConfiguration(nextConfiguration);
    await options.host.reload((signal) => options.start(
        signal,
        nextConfiguration.clientExtensions,
        failures,
    ));

    const loaded = options.host.current()?.loadedExtensionIds() ?? [];
    if (failures.length === 0) return loaded;

    const stateLabel = loaded.length === 0 ? "none loaded" : "some failed";
    throw new ClientExtensionReloadPartialFailure(
        loaded.length === 0 ? "none" : "some",
        `${stateLabel}: ${failures.slice(0, 3)
            .map(boundedExtensionReloadFailure).join("; ")}`
            + (failures.length > 3
                ? `; and ${failures.length - 3} more`
                : ""),
        loaded,
        failures.map(boundedExtensionReloadFailure),
    );
}
