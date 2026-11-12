import { realpathSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";

import {
    defaultVeraConfigPath,
    loadOptionalVeraConfig,
    parseSkillPatterns,
    VeraConfigError,
    veraConfigProblem,
    type VeraConfig,
} from "../config.ts";
import { collectConfigProblem, describeConfigProblem } from "../config/diagnostic.ts";
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

type Remembered<T> =
    | { readonly state: "loaded"; readonly value: T }
    | { readonly state: "kept"; readonly value: T; readonly problem: string }
    | { readonly state: "lost"; readonly problem: string };

// Per process and per path. An absent file loads as no settings, so only a file
// that has never loaded in this process turns every skill off.
const lastHomeConfigs = new Map<string, { readonly value: VeraConfig | undefined }>();
const lastProjectLists = new Map<string, { readonly value: readonly string[] }>();
const EVERY_SKILL: readonly string[] = ["*"];

// The host calls this at startup, so a file that breaks before the first
// session still has the settings the host started with.
export function rememberSkillSettings(projectRoot?: string): void {
    readHomeSettings();
    if (projectRoot !== undefined) {
        readProjectSkillSettings(projectRoot);
    }
}

// The home config skills use: the last one that loaded while the file is broken.
export function homeSkillConfig(): VeraConfig | undefined {
    const home = readHomeSettings();
    return home.state === "lost" ? undefined : home.value;
}

// Reads the home config and enabled extensions from disk, so every caller
// of the catalog sees the same set without threading it through the host.
export function resolveSkillSources(): SkillSources {
    const warnings: string[] = [];
    const home = readHomeSettings();
    if (home.state !== "loaded") {
        warnings.push(skillSettingsNotice("config.json", home));
    }
    const config = home.state === "lost" ? undefined : home.value;
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
        disabledSkills: home.state === "lost"
            ? EVERY_SKILL
            : config?.disabled_skills ?? [],
        extensionRoots,
        warnings,
    };
}

export interface ProjectSkillSettings {
    readonly disabledSkills: readonly string[];
    readonly warnings: readonly string[];
}

export function readProjectSkillSettings(
    projectRoot: string,
): ProjectSkillSettings {
    const path = join(projectRoot, ".vera", "config.json");
    const project = remember(lastProjectLists, path, () => loadProjectList(path));
    if (project.state === "loaded") {
        return { disabledSkills: project.value, warnings: [] };
    }
    return {
        disabledSkills: project.state === "kept" ? project.value : EVERY_SKILL,
        warnings: [skillSettingsNotice(".vera/config.json", project)],
    };
}

function readHomeSettings(): Remembered<VeraConfig | undefined> {
    return remember(
        lastHomeConfigs,
        defaultVeraConfigPath(),
        () => loadOptionalVeraConfig(),
    );
}

function loadProjectList(path: string): readonly string[] {
    let source: string;
    try {
        source = readRegularFileTextSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(source);
    } catch (error) {
        throw new VeraConfigError(path, `it is not valid JSON (${errorMessage(error)})`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new VeraConfigError(path, "it is not a JSON object");
    }
    const { value: patterns, problem } = collectConfigProblem(() =>
        parseSkillPatterns((raw as Record<string, unknown>).disabled_skills)
    );
    if (patterns === undefined) {
        throw new VeraConfigError(
            path,
            problem === undefined
                ? "disabled_skills is not a valid list"
                : describeConfigProblem(problem),
            problem?.field ?? "disabled_skills",
        );
    }
    return patterns;
}

function remember<T>(
    memory: Map<string, { readonly value: T }>,
    path: string,
    load: () => T,
): Remembered<T> {
    try {
        const value = load();
        memory.set(path, { value });
        return { state: "loaded", value };
    } catch (error) {
        const problem = error instanceof Error
            ? veraConfigProblem(error)
            : String(error);
        const kept = memory.get(path);
        return kept === undefined
            ? { state: "lost", problem }
            : { state: "kept", value: kept.value, problem };
    }
}

function skillSettingsNotice(
    file: string,
    read: Exclude<Remembered<unknown>, { readonly state: "loaded" }>,
): string {
    const reason = `${file} could not be read: ${read.problem.replace(/\.$/, "")}.`;
    return read.state === "kept"
        ? `${reason} Skills use the last settings that loaded.`
        : `${reason} Skills are off until it loads.`;
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
