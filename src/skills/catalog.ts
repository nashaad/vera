import { runtimePath } from "../release/runtime-path.ts";
import {
    readdir,
    realpath,
    stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    loadSkillPackage,
    type LoadedSkillPackage,
} from "./package.ts";
import { veraProfileDirectory } from "../profile-paths.ts";
import {
    isSkillDisabled,
    readProjectSkillSettings,
    resolveSkillSources,
    type ExtensionSkillRoot,
} from "./sources.ts";
import type { PluginCatalog, PluginRoot } from "../plugins/catalog.ts";

export type SkillScope = "system" | "extension" | "plugin" | "user" | "project";

export interface CatalogSkill extends LoadedSkillPackage {
    readonly scope: SkillScope;
    readonly extensionId?: string;
    readonly plugin?: string;
}

export interface SkillCatalog {
    readonly skills: readonly CatalogSkill[];
    // Matched by `disabled_skills`; absent from every other use of the catalog.
    readonly disabledSkills: readonly CatalogSkill[];
    readonly warnings: readonly string[];
    // Warnings that name a plugin or a path inside one. They stay out of the
    // prompt contribution and surface in the catalog and plugin views.
    readonly pluginWarnings: readonly string[];
}

export interface LoadSkillCatalogOptions {
    // Without a project root only system, extension, plugin and user skills load.
    readonly projectRoot?: string;
    readonly systemDirectory?: string;
    readonly userDirectory?: string;
    // These default to the home config, enabled extensions and enabled plugins.
    // The project's own disabled_skills is always added on top.
    readonly disabledSkills?: readonly string[];
    readonly extensionRoots?: readonly ExtensionSkillRoot[];
    readonly pluginRoots?: readonly PluginRoot[];
    readonly pluginCatalog?: PluginCatalog;
}

export function bundledSkillDirectory(): string {
    return runtimePath(join(import.meta.dir, "bundled"), "src/skills/bundled");
}

export function defaultUserSkillDirectory(): string {
    return join(veraProfileDirectory(), "skills");
}

export function projectSkillDirectory(projectRoot: string): string {
    return join(projectRoot, ".vera", "skills");
}

export async function loadSkillCatalog(
    options: LoadSkillCatalogOptions,
): Promise<SkillCatalog> {
    const warnings: string[] = [];
    const pluginWarnings: string[] = [];
    let disabledPatterns = options.disabledSkills;
    let extensionRoots = options.extensionRoots;
    let pluginRoots = options.pluginRoots;
    if (options.pluginCatalog !== undefined) {
        pluginWarnings.push(...options.pluginCatalog.warnings);
        pluginRoots ??= options.pluginCatalog.skill_roots;
    }
    if (disabledPatterns === undefined || extensionRoots === undefined || pluginRoots === undefined) {
        const sources = resolveSkillSources(options.pluginCatalog);
        disabledPatterns ??= sources.disabledSkills;
        extensionRoots ??= sources.extensionRoots;
        pluginRoots ??= sources.pluginRoots;
        warnings.push(...sources.warnings);
        pluginWarnings.push(...sources.pluginWarnings);
    }
    if (options.projectRoot !== undefined) {
        const project = readProjectSkillSettings(options.projectRoot);
        warnings.push(...project.warnings);
        disabledPatterns = [...disabledPatterns, ...project.disabledSkills];
    }
    const roots: readonly {
        readonly scope: SkillScope;
        readonly path: string;
        readonly extensionId?: string;
        readonly plugin?: string;
    }[] = [
        {
            scope: "system",
            path: options.systemDirectory ?? bundledSkillDirectory(),
        },
        ...extensionRoots.map((root) => ({
            scope: "extension" as const,
            path: root.path,
            extensionId: root.extensionId,
        })),
        ...pluginRoots.map((root) => ({
            scope: "plugin" as const,
            path: root.path,
            plugin: root.plugin,
        })),
        {
            scope: "user",
            path: options.userDirectory ?? defaultUserSkillDirectory(),
        },
        ...(options.projectRoot === undefined ? [] : [{
            scope: "project" as const,
            path: projectSkillDirectory(options.projectRoot),
        }]),
    ];
    const byName = new Map<string, CatalogSkill>();

    for (const root of roots) {
        const rootWarnings = root.scope === "plugin" ? pluginWarnings : warnings;
        const packages = await loadRoot(root.path, root.scope, rootWarnings);
        for (const loaded of packages) {
            const skill: CatalogSkill = {
                ...loaded,
                ...(root.extensionId === undefined ? {} : { extensionId: root.extensionId }),
                ...(root.plugin === undefined ? {} : { plugin: root.plugin }),
            };
            const previous = byName.get(skill.metadata.name);
            if (previous !== undefined) {
                const override =
                    `${skill.metadata.name} from ${skill.directory} overrides ${previous.directory}`;
                if (skill.plugin !== undefined || previous.plugin !== undefined) {
                    pluginWarnings.push(override);
                } else {
                    warnings.push(override);
                }
            }
            byName.set(skill.metadata.name, skill);
        }
    }

    const sorted = [...byName.values()].sort((left, right) =>
        left.metadata.name.localeCompare(right.metadata.name)
    );
    return {
        skills: sorted.filter((skill) =>
            !isSkillDisabled(skill.metadata.name, disabledPatterns)
        ),
        disabledSkills: sorted.filter((skill) =>
            isSkillDisabled(skill.metadata.name, disabledPatterns)
        ),
        warnings,
        pluginWarnings: [...new Set(pluginWarnings)],
    };
}

export function findSkill(
    catalog: SkillCatalog,
    name: string,
): CatalogSkill | undefined {
    return catalog.skills.find((skill) => skill.metadata.name === name);
}

export function findSkillByPath(
    catalog: SkillCatalog,
    skillPath: string,
): CatalogSkill | undefined {
    return catalog.skills.find((skill) => skill.skillPath === skillPath);
}

export function findDisabledSkillByPath(
    catalog: SkillCatalog,
    skillPath: string,
): CatalogSkill | undefined {
    return catalog.disabledSkills.find((skill) => skill.skillPath === skillPath);
}

async function loadRoot(
    configuredRoot: string,
    scope: SkillScope,
    warnings: string[],
): Promise<readonly CatalogSkill[]> {
    let root: string;
    try {
        root = await realpath(configuredRoot);
    } catch (error) {
        if (isMissing(error)) {
            return [];
        }
        warnings.push(
            `${scope} skill directory could not be read: ${errorMessage(error)}`,
        );
        return [];
    }

    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        warnings.push(
            `${scope} skill directory could not be read: ${errorMessage(error)}`,
        );
        return [];
    }

    const skills: CatalogSkill[] = [];
    for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        if (entry.name.startsWith(".")) {
            continue;
        }
        if (!entry.isDirectory() && !(await isDirectorySymlink(root, entry))) {
            continue;
        }
        const directory = join(root, entry.name);
        try {
            skills.push({
                ...(await loadSkillPackage(directory)),
                scope,
            });
        } catch (error) {
            if (!isMissing(error)) {
                warnings.push(`${directory}: ${errorMessage(error)}`);
            }
        }
    }
    return skills;
}

async function isDirectorySymlink(
    root: string,
    entry: Dirent,
): Promise<boolean> {
    if (!entry.isSymbolicLink()) {
        return false;
    }
    try {
        return (await stat(join(root, entry.name))).isDirectory();
    } catch {
        return false;
    }
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
