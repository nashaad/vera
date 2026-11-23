import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { parseSkillSource, SKILL_FILENAME } from "../skills/package.ts";
import type { PluginSkillComponent } from "./components.ts";
import { errorMessage, isDirectory, isFile, isWithin } from "./package-files.ts";
import { PLUGIN_SKILL_MAX_BYTES } from "./naming.ts";

export function loadSkills(
    configuredRoots: readonly string[],
    packageRoot: string,
    warnings: string[],
): readonly PluginSkillComponent[] {
    const roots: string[] = [];
    const seenRoots = new Set<string>();
    for (const configuredRoot of configuredRoots) {
        if (!isDirectory(configuredRoot)) continue;
        let root: string;
        try {
            root = realpathSync(configuredRoot);
        } catch (error) {
            warnings.push(`skills ${configuredRoot}: ${errorMessage(error)}`);
            continue;
        }
        if (!isWithin(packageRoot, root)) {
            warnings.push(`skills directory leaves the plugin: ${configuredRoot}`);
            continue;
        }
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        roots.push(root);
    }

    const byName = new Map<string, PluginSkillComponent>();
    for (const root of roots) {
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch (error) {
            warnings.push(`skills directory could not be read: ${errorMessage(error)}`);
            continue;
        }
        for (const entry of entries.toSorted((left, right) =>
            left.name.localeCompare(right.name)
        )) {
            if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
            const directory = join(root, entry.name);
            if (lstatSync(directory).isSymbolicLink()) {
                warnings.push(`skill ${entry.name}: directory is a symlink`);
                continue;
            }
            const skillPath = join(directory, SKILL_FILENAME);
            if (!isFile(skillPath)) continue;
            try {
                if (lstatSync(skillPath).size > PLUGIN_SKILL_MAX_BYTES) {
                    throw new Error(
                        `${SKILL_FILENAME} is larger than ${PLUGIN_SKILL_MAX_BYTES} bytes`,
                    );
                }
                const source = readFileSync(skillPath, "utf8");
                const parsed = parseSkillSource(source);
                if (parsed.metadata.name !== entry.name) {
                    throw new Error(
                        `name ${parsed.metadata.name} must match directory ${entry.name}`,
                    );
                }
                const previous = byName.get(parsed.metadata.name);
                if (previous !== undefined) {
                    warnings.push(
                        `skill ${parsed.metadata.name} from ${directory} overrides ${previous.directory}`,
                    );
                }
                byName.set(parsed.metadata.name, {
                    name: parsed.metadata.name,
                    root,
                    directory,
                });
            } catch (error) {
                warnings.push(`skill ${entry.name}: ${errorMessage(error)}`);
            }
        }
    }
    return [...byName.values()].toSorted((left, right) =>
        left.name.localeCompare(right.name)
    );
}
