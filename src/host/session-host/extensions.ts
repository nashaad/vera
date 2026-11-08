import type { VeraConfig } from "../../config.ts";
import { hostExtensionConfigs } from "../../extensions/host-set.ts";
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
}

export async function startSessionExtensions(options: SessionExtensionOptions) {
    const { home, startupLog, startupFindings, timed } = options;
    const extensionLoadFailures: ExtensionLoadFailure[] = [];
    const hostExtensionSet = hostExtensionConfigs(options.config);
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
