import type { VeraExtensionConfig } from "../../src/config.ts";
import type { ClientExtensionRegistry } from
    "../../src/extensions/client-registry.ts";
import {
    configuredTuiClientExtensions,
    type TuiClientExtensionHostController,
} from "./client-extension-host.ts";
import type { TuiClientExtensionReloadSnapshot } from "./diagnostics.ts";

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

export interface ClientExtensionReloadFailureOutcome {
    readonly snapshot: TuiClientExtensionReloadSnapshot;
    readonly notice: string;
}

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

export function boundedExtensionReloadFailure(message: string): string {
    const compact = message.replaceAll(/\s+/g, " ").trim();
    return compact.length <= 240
        ? compact
        : `${compact.slice(0, 239).trimEnd()}…`;
}

export function clientExtensionReloadStarted(): TuiClientExtensionReloadSnapshot {
    return {
        status: "reloading",
        loadedExtensionIds: [],
        failures: [],
    };
}

export function clientExtensionReloadSucceeded(
    loadedExtensionIds: readonly string[],
): TuiClientExtensionReloadSnapshot {
    return {
        status: "success",
        loadedExtensionIds,
        failures: [],
    };
}

export function clientExtensionReloadFailed(
    error: unknown,
    fallbackLoadedExtensionIds: readonly string[],
): ClientExtensionReloadFailureOutcome {
    const partialReload =
        error instanceof ClientExtensionReloadPartialFailure;
    const loadedExtensionIds = partialReload
        ? error.loadedExtensionIds
        : fallbackLoadedExtensionIds;
    const failures = partialReload
        ? error.failures
        : [boundedExtensionReloadFailure(
            error instanceof Error ? error.message : String(error),
        )];
    const message = boundedExtensionReloadFailure(
        error instanceof Error ? error.message : String(error),
    );
    const kind = partialReload ? error.kind : undefined;
    return {
        snapshot: {
            status: partialReload && kind === "some"
                ? "partial"
                : "failed",
            loadedExtensionIds,
            failures,
        },
        notice: partialReload
            ? `Client extensions reloaded with failures: ${kind}: ${message}`
            : `Client extensions could not reload: ${message}`,
    };
}

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
