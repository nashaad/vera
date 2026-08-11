import {
    readdir,
    realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    loadSkillPackage,
    type LoadedSkillPackage,
} from "./package.ts";

export type SkillScope = "system" | "user" | "project";

export interface CatalogSkill extends LoadedSkillPackage {
    readonly scope: SkillScope;
}

export interface SkillCatalog {
    readonly skills: readonly CatalogSkill[];
    readonly warnings: readonly string[];
}

export interface LoadSkillCatalogOptions {
    readonly projectRoot: string;
    readonly systemDirectory?: string;
    readonly userDirectory?: string;
}

export function bundledSkillDirectory(): string {
    return join(import.meta.dir, "bundled");
}

export function defaultUserSkillDirectory(): string {
    return join(homedir(), ".vera", "skills");
}

export function projectSkillDirectory(projectRoot: string): string {
    return join(projectRoot, ".vera", "skills");
}

export async function loadSkillCatalog(
    options: LoadSkillCatalogOptions,
): Promise<SkillCatalog> {
    const roots: readonly {
        readonly scope: SkillScope;
        readonly path: string;
    }[] = [
        {
            scope: "system",
            path: options.systemDirectory ?? bundledSkillDirectory(),
        },
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
    const warnings: string[] = [];

    for (const root of roots) {
        const packages = await loadRoot(root.path, root.scope, warnings);
        for (const skill of packages) {
            const previous = byName.get(skill.metadata.name);
            if (previous !== undefined) {
                warnings.push(
                    `${skill.metadata.name} from ${skill.directory} overrides ${previous.directory}`,
                );
            }
            byName.set(skill.metadata.name, skill);
        }
    }

    return {
        skills: [...byName.values()].sort((left, right) =>
            left.metadata.name.localeCompare(right.metadata.name)
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
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
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

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
