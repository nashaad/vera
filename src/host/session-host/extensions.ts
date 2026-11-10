import type { VeraConfig, VeraExtensionConfig } from "../../config.ts";
import { hostExtensionConfigs } from "../../extensions/host-set.ts";
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
    readonly startupLog: HostLog;
    readonly startupFindings: StartupFindings;
    readonly timed: <T>(phase: string, run: () => T | Promise<T>) => Promise<T>;
    readonly onExtensionFailure?: (failure: ExtensionRegistryFailure) => void;
    readonly remoteExtensions?: WorkerExtensionServices;
}

export async function startSessionExtensions(options: SessionExtensionOptions) {
    const { home, startupLog, startupFindings, timed } = options;
    const extensionLoadFailures: ExtensionLoadFailure[] = [];
    const available = options.remoteExtensions === undefined
        ? undefined : new Set(options.remoteExtensions.catalog.extensionOrder);
    const hostExtensionSet = hostExtensionConfigs(options.config).filter((extension) => {
        if (available === undefined) return true;
        try {
            const id = loadExtensionManifest(extension.path).manifest.id;
            return available.has(id) && !HOST_EXTENSION_IDS.has(id);
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
            onFailure: (failure) => {
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
            },
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
        }),
    );
    const sessionIdentity = extensions.sessionIdentity();
    if (sessionIdentity === undefined) {
        await extensions.close();
        throw new Error(
            "Resident host requires one sessions.identity provider",
        );
    }
    return { extensions, sessionIdentity, extensionLoadFailures };
}

export function withoutHostExtensions(configs: readonly VeraExtensionConfig[]): readonly VeraExtensionConfig[] {
    return configs.filter((extension) => {
        try { return !HOST_EXTENSION_IDS.has(loadExtensionManifest(extension.path).manifest.id); }
        catch { return true; }
    });
}
