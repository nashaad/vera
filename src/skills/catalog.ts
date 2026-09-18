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
    resolveSkillSources,
    type ExtensionSkillRoot,
} from "./sources.ts";

export type SkillScope = "system" | "extension" | "user" | "project";

export interface CatalogSkill extends LoadedSkillPackage {
    readonly scope: SkillScope;
    readonly extensionId?: string;
}

export interface SkillCatalog {
    readonly skills: readonly CatalogSkill[];
    // Matched by `disabled_skills`; absent from every other use of the catalog.
    readonly disabledSkills: readonly CatalogSkill[];
    readonly warnings: readonly string[];
}

export interface LoadSkillCatalogOptions {
    readonly projectRoot: string;
    readonly systemDirectory?: string;
    readonly userDirectory?: string;
    // Both default to the home config and enabled extensions.
    readonly disabledSkills?: readonly string[];
    readonly extensionRoots?: readonly ExtensionSkillRoot[];
}

export function bundledSkillDirectory(): string {
    return join(import.meta.dir, "bundled");
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
    let disabledPatterns = options.disabledSkills;
    let extensionRoots = options.extensionRoots;
    if (disabledPatterns === undefined || extensionRoots === undefined) {
        const sources = resolveSkillSources();
        disabledPatterns ??= sources.disabledSkills;
        extensionRoots ??= sources.extensionRoots;
        warnings.push(...sources.warnings);
    }
    const roots: readonly {
        readonly scope: SkillScope;
        readonly path: string;
        readonly extensionId?: string;
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
        {
            scope: "user",
            path: options.userDirectory ?? defaultUserSkillDirectory(),
        },
        {
            scope: "project",
            path: projectSkillDirectory(options.projectRoot),
        },
    ];
    const byName = new Map<string, CatalogSkill>();

    for (const root of roots) {
        const packages = await loadRoot(root.path, root.scope, warnings);
        for (const loaded of packages) {
            const skill: CatalogSkill = root.extensionId === undefined
                ? loaded
                : { ...loaded, extensionId: root.extensionId };
            const previous = byName.get(skill.metadata.name);
            if (previous !== undefined) {
                warnings.push(
                    `${skill.metadata.name} from ${skill.directory} overrides ${previous.directory}`,
                );
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
