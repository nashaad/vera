import type { VeraConfig, VeraExtensionConfig } from "../../config.ts";
import { hostExtensionConfigSet } from "../../extensions/host-set.ts";
import type { PluginSnapshot } from "../../plugins/catalog.ts";
import { loadExtensionManifest } from "../../extensions/manifest.ts";
import { HOST_EXTENSION_IDS, type WorkerExtensionServices } from "../pool/extension-catalog.ts";
import { veraMachineDirectoryIn } from "../../profile-paths.ts";
import type { HostLog } from "../host-log.ts";

import {
    startExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../extensions/registry.ts";
import type { ExtensionLoadFailure } from "../protocol.ts";
import {
    literalSecretDetail,
    StartupFindings,
} from "../startup-findings.ts";

interface SessionExtensionOptions {
    readonly config: VeraConfig;
    readonly home: string;
    readonly pluginSnapshot: PluginSnapshot;
    readonly startupLog: HostLog;
    readonly startupFindings: StartupFindings;
    readonly timed: <T>(phase: string, run: () => T | Promise<T>) => Promise<T>;
    readonly onExtensionFailure?: (failure: ExtensionRegistryFailure) => void;
    readonly onToolDescriptionChanged?: (
        extensionId: string,
        name: string,
        description: string,
    ) => void;
    readonly remoteExtensions?: WorkerExtensionServices;
    readonly availableExtensionIds?: readonly string[];
}

export async function startSessionExtensions(options: SessionExtensionOptions) {
    const { home, startupLog, startupFindings, timed } = options;
    const extensionLoadFailures: ExtensionLoadFailure[] = [];
    const failedPaths = new Set<string>();
    const availableIds = options.remoteExtensions?.catalog.extensionOrder ?? options.availableExtensionIds;
    const available = availableIds === undefined ? undefined : new Set(availableIds);
    const hostSet = hostExtensionConfigSet(options.config, options.pluginSnapshot);
    const reportFailure = (failure: ExtensionRegistryFailure): void => {
        failedPaths.add(failure.path);
        startupLog({
            type: "host_startup_extension_failed",
            extension_id: failure.extensionId ?? failure.path,
            message: failure.message,
        });
        startupFindings.record({
            extensionId: failure.extensionId ?? failure.path,
            detail: `did not load: ${failure.message}`,
        });
        extensionLoadFailures.push({
            extension_id: failure.extensionId ?? failure.path,
            message: failure.message,
        });
        options.onExtensionFailure?.(failure);
    };
    for (const warning of hostSet.warnings) {
        startupLog({ type: "host_startup_plugin_warning", message: warning });
    }
    for (const failure of hostSet.failures) reportFailure(failure);
    const hostExtensionSet = hostSet.extensions.filter((extension) => {
        if (available === undefined) return true;
        try {
            const id = loadExtensionManifest(extension.path).manifest.id;
            return available.has(id)
                && (options.remoteExtensions === undefined || !HOST_EXTENSION_IDS.has(id));
        } catch {
            return false;
        }
    });
    const extensions = await timed(
        "extension_registry",
        () => startExtensionRegistry({
            extensions: hostExtensionSet,
            storageRoots: {
                profile: home,
                machine: veraMachineDirectoryIn(home),
            },
            onFailure: reportFailure,
            onLiteralSecret: (finding) => {
                startupFindings.record({
                    extensionId: finding.extensionId,
                    detail: literalSecretDetail(
                        finding.configPath,
                        finding.prefix,
                    ),
                });
            },
            onActivationTiming: (timing) => startupLog({
                type: "host_startup_extension",
                extension_id: timing.extensionId,
                outcome: timing.outcome,
                duration_ms: timing.durationMs,
            }),
            ...(options.onToolDescriptionChanged === undefined
                ? {}
                : { onToolDescriptionChanged: options.onToolDescriptionChanged }),
        }),
    );
    const sessionIdentity = extensions.sessionIdentity();
    if (sessionIdentity === undefined) {
        await extensions.close();
        throw new Error(
            "Resident host requires one sessions.identity provider",
        );
    }
    const configuredByPath = new Map(hostSet.extensions.map((entry) => [entry.path, entry]));
    const loadedIds = new Set(extensions.extensionIds());
    const entries = options.pluginSnapshot.host_extensions.flatMap((part) => {
        const configured = configuredByPath.get(part.directory);
        if (configured?.enabled !== true || !loadedIds.has(part.id) || failedPaths.has(part.directory)) return [];
        return [{
            plugin: part.plugin,
            id: part.id,
            directory: part.directory,
            package_identity: part.package_identity,
            enabled: configured.enabled,
            config: structuredClone(configured.config),
        }];
    });
    return {
        extensions,
        sessionIdentity,
        extensionLoadFailures,
        pluginWorkerExtensions: {
            entries,
            owners: options.pluginSnapshot.host_extension_owners,
        },
    };
}

export function withoutHostExtensions(configs: readonly VeraExtensionConfig[]): readonly VeraExtensionConfig[] {
    return configs.filter((extension) => {
        try { return !HOST_EXTENSION_IDS.has(loadExtensionManifest(extension.path).manifest.id); }
        catch { return true; }
    });
}
