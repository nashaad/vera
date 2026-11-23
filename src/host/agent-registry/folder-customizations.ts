import { realpath } from "node:fs/promises";

import { loadCustomizationCatalog } from "../../customize/catalog.ts";
import type { CustomizationCatalog, CustomizationSource } from "../../customize/types.ts";
import { readPluginCatalog } from "../../plugins/catalog.ts";
import { loadSkillCommandCatalog, type SkillCommandCatalog } from "../../skills/commands.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { loadAgentCatalogFor, newSessionAgentsOf, type NewSessionAgents } from "./select.ts";
import { resolveInstructionRoot } from "./support.ts";

// The page that shows these lists cuts at the same sizes, so a larger reply would carry text nobody sees.
export const FOLDER_CUSTOMIZATIONS_MAX_ENTRIES = 500;
export const FOLDER_CUSTOMIZATIONS_MAX_CONTENT_CHARS = 20_000;
export const FOLDER_CUSTOMIZATIONS_MAX_WARNINGS = 50;

export interface FolderCustomizations {
    readonly skills: SkillCommandCatalog;
    readonly agents: NewSessionAgents;
    readonly sources: CustomizationCatalog;
}

// Reads what a session created in `workspace` would load, or in a chat when there is none.
// Every loader here only reads; nothing is created and no session starts.
export async function listFolderCustomizations(
    reg: AgentRegistry,
    workspace: string | undefined,
): Promise<FolderCustomizations> {
    // A session opens in the resolved folder, and a folder that is gone still reads as the home's items alone.
    const folder = workspace === undefined ? undefined : await realpath(workspace).catch(() => workspace);
    const pluginCatalog = readPluginCatalog();
    const agentCatalog = await loadAgentCatalogFor(reg, folder, pluginCatalog);
    const [skills, sources] = await Promise.all([
        loadSkillCommandCatalog({
            ...(folder === undefined ? {} : { projectRoot: folder }),
            pluginCatalog,
        }),
        loadCustomizationCatalog({
            ...(folder === undefined ? {} : { workspace: folder, instructionRoot: resolveInstructionRoot(folder) }),
            agents: agentCatalog,
            pluginCatalog,
        }),
    ]);
    const agents = newSessionAgentsOf(agentCatalog);
    return {
        skills: {
            skills: skills.skills.slice(0, FOLDER_CUSTOMIZATIONS_MAX_ENTRIES),
            warnings: skills.warnings.slice(0, FOLDER_CUSTOMIZATIONS_MAX_WARNINGS),
        },
        agents: {
            ...agents,
            agents: agents.agents.slice(0, FOLDER_CUSTOMIZATIONS_MAX_ENTRIES),
            notices: agents.notices.slice(0, FOLDER_CUSTOMIZATIONS_MAX_WARNINGS),
        },
        sources: {
            sources: limitSources(sources.sources, FOLDER_CUSTOMIZATIONS_MAX_ENTRIES).map((source) =>
                source.content.length > FOLDER_CUSTOMIZATIONS_MAX_CONTENT_CHARS
                    ? { ...source, content: source.content.slice(0, FOLDER_CUSTOMIZATIONS_MAX_CONTENT_CHARS) }
                    : source),
            warnings: sources.warnings.slice(0, FOLDER_CUSTOMIZATIONS_MAX_WARNINGS),
        },
    };
}

// Plugin rows are few and the page has no way to say a category was cut, so
// they are kept whole and the other rows fill the rest of the page.
function limitSources(
    sources: readonly CustomizationSource[],
    limit: number,
): readonly CustomizationSource[] {
    if (sources.length <= limit) return sources;
    const plugins = sources.filter((source) => source.category === "plugins");
    const others = sources.filter((source) => source.category !== "plugins");
    return [
        ...others.slice(0, Math.max(0, limit - plugins.length)),
        ...plugins,
    ].slice(0, limit);
}
