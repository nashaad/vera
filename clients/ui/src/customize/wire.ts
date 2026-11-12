// Catalog replies a session sends on its watch connection, and the lines that ask for them.
// Customize and the agent picker read these; the session view ignores them.

export type SourceCategory = "agents" | "skills" | "instructions" | "memory" | "extensions";
export type AgentScope = "project" | "user" | "extension";

export interface SkillInfo {
    readonly name: string;
    readonly description: string;
    // True when only a person can run the skill; the session never picks it on its own.
    readonly manualOnly: boolean;
}

export interface AgentInfo {
    readonly name: string;
    readonly description?: string;
    readonly scope: AgentScope;
    readonly writable: boolean;
    readonly tools?: readonly string[];
    readonly skills?: readonly string[];
    readonly posture?: string;
    readonly forbiddenAccess?: readonly string[];
    readonly subagentAssignment?: string;
    readonly defaultModel?: string;
    readonly defaultEffort?: string;
}

export interface SourceInfo {
    readonly id: string;
    readonly category: SourceCategory;
    readonly name: string;
    readonly description: string;
    readonly scope: string;
    readonly path?: string;
    readonly content: string;
    readonly editable: boolean;
    readonly status?: string;
}

export type CatalogReply =
    | { readonly type: "skills"; readonly requestId: string; readonly skills: readonly SkillInfo[]; readonly warnings: readonly string[] }
    | AgentCatalogReply
    | { readonly type: "sources"; readonly requestId: string; readonly sources: readonly SourceInfo[]; readonly warnings: readonly string[] }
    | AgentSelectedReply
    | { readonly type: "agent_rejected"; readonly requestId: string; readonly reason: string };

export interface AgentCatalogReply {
    readonly type: "agents";
    readonly requestId: string;
    readonly selected: string;
    readonly agents: readonly AgentInfo[];
    readonly notices: readonly string[];
}

export interface AgentSelectedReply {
    readonly type: "agent_selected";
    readonly requestId: string;
    readonly name: string;
    readonly notice?: string;
}

const CATEGORIES: readonly SourceCategory[] = ["agents", "skills", "instructions", "memory", "extensions"];
const SCOPES: readonly AgentScope[] = ["project", "user", "extension"];
// A catalog longer than this is cut; the page says how many it holds.
export const CATALOG_LIMIT = 500;
// Source bodies past this are cut for display; the file on disk holds the rest.
export const SOURCE_TEXT_LIMIT = 20_000;

type Fields = Record<string, unknown>;

export function listSkillsCommand(requestId: string): string {
    return line({ type: "list_skills", requestId });
}

export function listAgentsCommand(requestId: string): string {
    return line({ type: "list_agents", requestId });
}

export function listSourcesCommand(requestId: string): string {
    return line({ type: "list_customization_sources", requestId });
}

// The session switches agents at its next turn, not mid-turn.
export function selectAgentCommand(requestId: string, name: string): string {
    return line({ type: "select_agent", requestId, name });
}

export function parseCatalogLine(text: string): CatalogReply | undefined {
    const value = parseJson(text);
    if (!isFields(value) || typeof value.requestId !== "string") return undefined;
    const requestId = value.requestId;
    switch (value.type) {
        case "skill_catalog": {
            if (!Array.isArray(value.skills)) return undefined;
            const skills = value.skills.slice(0, CATALOG_LIMIT).flatMap((entry) => parseSkill(entry));
            return { type: "skills", requestId, skills, warnings: strings(value.warnings) };
        }
        case "agent_catalog": {
            if (!Array.isArray(value.agents) || typeof value.selected !== "string") return undefined;
            const agents = value.agents.slice(0, CATALOG_LIMIT).flatMap((entry) => parseAgent(entry));
            return { type: "agents", requestId, selected: value.selected, agents, notices: strings(value.notices) };
        }
        case "customization_sources": {
            const catalog = value.catalog;
            if (!isFields(catalog) || !Array.isArray(catalog.sources)) return undefined;
            const sources = catalog.sources.slice(0, CATALOG_LIMIT).flatMap((entry) => parseSource(entry));
            return { type: "sources", requestId, sources, warnings: strings(catalog.warnings) };
        }
        case "agent_selected": {
            if (typeof value.name !== "string") return undefined;
            const notice = typeof value.notice === "string" && value.notice.length > 0 ? value.notice : undefined;
            return { type: "agent_selected", requestId, name: value.name, ...(notice === undefined ? {} : { notice }) };
        }
        case "agent_rejected":
            return typeof value.reason === "string" ? { type: "agent_rejected", requestId, reason: value.reason } : undefined;
        default:
            return undefined;
    }
}

function parseSkill(value: unknown): SkillInfo[] {
    if (!isFields(value) || typeof value.name !== "string" || value.name.length === 0) return [];
    const description = typeof value.description === "string" ? value.description : "";
    return [{ name: value.name, description, manualOnly: value.disableModelInvocation === true }];
}

function parseAgent(value: unknown): AgentInfo[] {
    if (!isFields(value) || typeof value.name !== "string" || value.name.length === 0) return [];
    const scope = SCOPES.find((candidate) => candidate === value.scope);
    if (scope === undefined) return [];
    const pair = isFields(value.defaultPair) && typeof value.defaultPair.name === "string" ? value.defaultPair : undefined;
    return [{
        name: value.name,
        scope,
        writable: value.writable === true,
        ...optionalString("description", value.description),
        ...optionalList("tools", value.tools),
        ...optionalList("skills", value.skills),
        ...optionalString("posture", value.posture),
        ...optionalList("forbiddenAccess", value.forbiddenAccess),
        ...optionalString("subagentAssignment", value.subagentAssignment),
        ...(pair === undefined ? {} : optionalString("defaultModel", pair.name)),
        ...(pair === undefined ? {} : optionalString("defaultEffort", pair.effort)),
    }];
}

function parseSource(value: unknown): SourceInfo[] {
    if (!isFields(value) || typeof value.id !== "string" || typeof value.name !== "string") return [];
    const category = CATEGORIES.find((candidate) => candidate === value.category);
    if (category === undefined) return [];
    const content = typeof value.content === "string" ? value.content.slice(0, SOURCE_TEXT_LIMIT) : "";
    return [{
        id: value.id,
        category,
        name: value.name,
        description: typeof value.description === "string" ? value.description : "",
        scope: typeof value.scope === "string" ? value.scope : "",
        content,
        editable: value.editable === true,
        ...optionalString("path", value.path),
        ...optionalString("status", value.status),
    }];
}

function optionalString<Key extends string>(key: Key, value: unknown): { readonly [K in Key]?: string } {
    return (typeof value === "string" && value.length > 0 ? { [key]: value } : {}) as { readonly [K in Key]?: string };
}

function optionalList<Key extends string>(key: Key, value: unknown): { readonly [K in Key]?: readonly string[] } {
    return (Array.isArray(value) ? { [key]: strings(value) } : {}) as { readonly [K in Key]?: readonly string[] };
}

function strings(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
