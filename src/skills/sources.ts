import { realpathSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

import { loadOptionalVeraConfig, type VeraConfig } from "../config.ts";
import { includedExtensionConfigs } from "../extensions/included.ts";
import { mergeExtensionScopes } from "../extensions/discovery.ts";
import { loadExtensionManifest } from "../extensions/manifest.ts";

export interface ExtensionSkillRoot {
    readonly extensionId: string;
    readonly path: string;
}

export interface SkillSources {
    readonly disabledSkills: readonly string[];
    readonly extensionRoots: readonly ExtensionSkillRoot[];
    readonly warnings: readonly string[];
}

export function isSkillDisabled(
    name: string,
    patterns: readonly string[],
): boolean {
    return patterns.some((pattern) =>
        pattern.endsWith("*")
            ? name.startsWith(pattern.slice(0, -1))
            : name === pattern
    );
}

// Reads the home config and enabled extensions from disk, so every caller
// of the catalog sees the same set without threading it through the host.
export function resolveSkillSources(): SkillSources {
    const warnings: string[] = [];
    let config: VeraConfig | undefined;
    try {
        config = loadOptionalVeraConfig();
    } catch (error) {
        warnings.push(`skill settings could not be read: ${errorMessage(error)}`);
    }
    let extensions;
    try {
        extensions = mergeExtensionScopes(
            includedExtensionConfigs(
                config?.disabled_included_extensions ?? [],
            ),
            config?.extensions ?? [],
        );
    } catch (error) {
        warnings.push(`extension skills could not be listed: ${errorMessage(error)}`);
        extensions = [];
    }
    const extensionRoots: ExtensionSkillRoot[] = [];
    for (const extension of extensions) {
        if (!extension.enabled) continue;
        try {
            const loaded = loadExtensionManifest(extension.path);
            for (const directory of loaded.manifest.contributes.skills) {
                const path = resolve(loaded.directory, directory);
                if (!isInside(loaded.directory, path)) {
                    warnings.push(
                        `${loaded.manifest.id}: skills directory ${directory} leaves the extension`,
                    );
                    continue;
                }
                extensionRoots.push({ extensionId: loaded.manifest.id, path });
            }
        } catch {
            // A broken manifest is reported by the extension registry.
        }
    }
    return {
        disabledSkills: config?.disabled_skills ?? [],
        extensionRoots,
        warnings,
    };
}

function isInside(root: string, path: string): boolean {
    let real: string;
    try {
        real = realpathSync(path);
    } catch {
        // A missing directory is skipped later by the catalog.
        real = path;
    }
    const offset = relative(root, real);
    return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
