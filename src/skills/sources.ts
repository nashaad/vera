import { realpathSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";

import {
    loadOptionalVeraConfig,
    parseSkillPatterns,
    type VeraConfig,
} from "../config.ts";
import { includedExtensionConfigs } from "../extensions/included.ts";
import { mergeExtensionScopes } from "../extensions/discovery.ts";
import { loadExtensionManifest } from "../extensions/manifest.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

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

export interface ProjectSkillSettings {
    readonly disabledSkills: readonly string[];
    readonly warnings: readonly string[];
}

// A broken project list is skipped with a warning so it never blocks the home list.
export function readProjectSkillSettings(
    projectRoot: string,
): ProjectSkillSettings {
    const path = join(projectRoot, ".vera", "config.json");
    let raw: unknown;
    try {
        raw = JSON.parse(readRegularFileTextSync(path));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { disabledSkills: [], warnings: [] };
        }
        return {
            disabledSkills: [],
            warnings: [`${path} could not be read: ${errorMessage(error)}`],
        };
    }
    const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).disabled_skills
        : undefined;
    const patterns = parseSkillPatterns(value);
    if (patterns === undefined) {
        return {
            disabledSkills: [],
            warnings: [`disabled_skills in ${path} is not a valid list and was ignored`],
        };
    }
    return { disabledSkills: patterns, warnings: [] };
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
