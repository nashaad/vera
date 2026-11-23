import {
    findSkill,
    loadSkillCatalog,
    type SkillCatalog,
} from "./catalog.ts";
import type { PluginCatalog } from "../plugins/catalog.ts";

export interface SkillCommandDescriptor {
    readonly name: string;
    readonly description: string;
    readonly disableModelInvocation: boolean;
    readonly plugin?: string;
}

export interface SkillCommandCatalog {
    readonly skills: readonly SkillCommandDescriptor[];
    readonly warnings: readonly string[];
}

export interface SkillInvocationAllowed {
    readonly allowed: true;
}

export interface SkillInvocationRefused {
    readonly allowed: false;
    readonly reason: string;
}

export type SkillInvocationDecision =
    | SkillInvocationAllowed
    | SkillInvocationRefused;

export async function loadSkillCommandCatalog(options: {
    readonly projectRoot?: string;
    readonly allowedSkills?: readonly string[];
    readonly pluginCatalog?: PluginCatalog;
}): Promise<SkillCommandCatalog> {
    const catalog = filterAllowedSkills(
        await loadSkillCatalog({
            ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
            ...(options.pluginCatalog === undefined ? {} : { pluginCatalog: options.pluginCatalog }),
        }),
        options.allowedSkills,
    );
    return {
        skills: catalog.skills.map((skill) => ({
            name: skill.metadata.name,
            description: skill.metadata.description,
            disableModelInvocation: skill.metadata.disableModelInvocation,
            ...(skill.plugin === undefined ? {} : { plugin: skill.plugin }),
        })),
        warnings: [...catalog.warnings, ...catalog.pluginWarnings],
    };
}

export async function decideSkillInvocation(options: {
    readonly projectRoot: string;
    readonly name: string;
    readonly allowedSkills?: readonly string[];
    readonly isSubagent: boolean;
}): Promise<SkillInvocationDecision> {
    if (options.isSubagent) {
        return {
            allowed: false,
            reason: "Skill slash commands are available only in top-level sessions.",
        };
    }
    const catalog = filterAllowedSkills(
        await loadSkillCatalog({ projectRoot: options.projectRoot }),
        options.allowedSkills,
    );
    if (findSkill(catalog, options.name) === undefined) {
        return {
            allowed: false,
            reason: `No skill named ${options.name} is available to this agent.`,
        };
    }
    return { allowed: true };
}

function filterAllowedSkills(
    catalog: SkillCatalog,
    allowedSkills?: readonly string[],
): SkillCatalog {
    if (allowedSkills === undefined) return catalog;
    return {
        ...catalog,
        skills: catalog.skills.filter((skill) =>
            allowedSkills.includes(skill.metadata.name)
        ),
    };
}
