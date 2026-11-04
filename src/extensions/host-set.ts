import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { VeraConfig, VeraExtensionConfig } from "../config.ts";
import { mergeExtensionScopes } from "./discovery.ts";
import { includedExtensionConfigs } from "./included.ts";
import { loadExtensionManifest } from "./manifest.ts";

/** The set a host runs in its main process. */
export function hostExtensionConfigs(
    config: Pick<VeraConfig, "disabled_included_extensions" | "extensions">,
): readonly VeraExtensionConfig[] {
    return mergeExtensionScopes(
        includedExtensionConfigs(config.disabled_included_extensions ?? []),
        config.extensions ?? [],
    );
}

/**
 * The set a worker runs: configured extensions as before, plus only included
 * extensions whose manifest provides model middleware.
 */
export function workerExtensionConfigs(
    config: Pick<VeraConfig, "disabled_included_extensions" | "extensions">,
): readonly VeraExtensionConfig[] {
    const configured = new Set(
        (config.extensions ?? []).map((extension) =>
            canonicalPath(extension.path)
        ),
    );
    return hostExtensionConfigs(config).filter((extension) =>
        configured.has(canonicalPath(extension.path))
        || providesModelMiddleware(extension.path)
    );
}

function providesModelMiddleware(path: string): boolean {
    try {
        return loadExtensionManifest(path).manifest.capabilities.includes(
            "hooks.model_middleware",
        );
    } catch {
        // A manifest that does not load is the host registry's failure to report.
        return false;
    }
}

function canonicalPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}
