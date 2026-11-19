import { realpath } from "node:fs/promises";

import { loadCustomizationCatalog } from "../../customize/catalog.ts";
import type { CustomizationCatalog } from "../../customize/types.ts";
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
    const agentCatalog = await loadAgentCatalogFor(reg, folder);
    const [skills, sources] = await Promise.all([
        loadSkillCommandCatalog(folder === undefined ? {} : { projectRoot: folder }),
        loadCustomizationCatalog({
            ...(folder === undefined ? {} : { workspace: folder, instructionRoot: resolveInstructionRoot(folder) }),
            agents: agentCatalog,
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
            sources: sources.sources.slice(0, FOLDER_CUSTOMIZATIONS_MAX_ENTRIES).map((source) =>
                source.content.length > FOLDER_CUSTOMIZATIONS_MAX_CONTENT_CHARS
                    ? { ...source, content: source.content.slice(0, FOLDER_CUSTOMIZATIONS_MAX_CONTENT_CHARS) }
                    : source),
            warnings: sources.warnings.slice(0, FOLDER_CUSTOMIZATIONS_MAX_WARNINGS),
        },
    };
}
