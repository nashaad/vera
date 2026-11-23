import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
    agentNameFromPath,
    parseAgentDefinition,
} from "../agents/definition.ts";
import type { PluginAgentComponent } from "./components.ts";
import { errorMessage, isDirectory, isWithin } from "./package-files.ts";
import { PLUGIN_AGENT_MAX_BYTES } from "./naming.ts";

export function loadAgents(
    configuredRoot: string,
    packageRoot: string,
    warnings: string[],
): readonly PluginAgentComponent[] {
    if (!isDirectory(configuredRoot)) return [];
    let root: string;
    try {
        root = realpathSync(configuredRoot);
    } catch (error) {
        warnings.push(`agents directory: ${errorMessage(error)}`);
        return [];
    }
    if (!isWithin(packageRoot, root)) {
        warnings.push(`agents directory leaves the plugin: ${configuredRoot}`);
        return [];
    }
    let entries;
    try {
        entries = readdirSync(root);
    } catch (error) {
        warnings.push(`agents directory could not be read: ${errorMessage(error)}`);
        return [];
    }
    const agents: PluginAgentComponent[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
        const path = join(root, entry);
        try {
            const details = lstatSync(path);
            if (details.isSymbolicLink()) throw new Error("file is a symlink");
            if (!details.isFile()) throw new Error("not a regular file");
            if (details.size > PLUGIN_AGENT_MAX_BYTES) {
                throw new Error(`file is larger than ${PLUGIN_AGENT_MAX_BYTES} bytes`);
            }
            const source = readFileSync(path, "utf8");
            const definition = parseAgentDefinition(agentNameFromPath(entry), source);
            agents.push({ name: definition.name, path, root });
        } catch (error) {
            warnings.push(`agent ${entry}: ${errorMessage(error)}`);
        }
    }
    return agents;
}
