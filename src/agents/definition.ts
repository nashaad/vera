/**
 * An agent is a thing you wear: instructions, what it may reach, and how it
 * asks. It is not a dial. Nothing here holds a model except an optional
 * default pair, and nothing here is edited by dialling.
 *
 * The file format is the skills convention — YAML frontmatter for the
 * structured keys, the body for the instructions — because a user who has
 * written one has written the other.
 */

import { basename } from "node:path";

const MAX_AGENT_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARACTERS = 1024;

export const AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A tool the agent's instructions may not have anticipated. */
export interface AgentNudge {
    /** A tool name, or `*` for every denial this agent sees. */
    readonly on: string;
    readonly text: string;
}

export interface AgentDefinition {
    readonly name: string;
    readonly description?: string;
    /**
     * Omitted means every tool, present and future. A present list is a
     * restriction to exactly those names — never a hint, never a preference.
     */
    readonly tools?: readonly string[];
    /** Same omitted-means-all rule, kept separate from tools on purpose. */
    readonly skills?: readonly string[];
    /**
     * A permission mode by name, resolved at wear and turn time rather than
     * frozen here: editing a mode has to reach the agents that name it.
     * Omitted means the host's current default, and that is dynamic on
     * purpose.
     */
    readonly posture?: string;
    /** Permission modes this agent cannot coexist with. */
    readonly forbiddenAccess?: readonly string[];
    /** Reserved. Only `"full"` is accepted today. */
    readonly context?: "full";
    readonly defaultPair?: {
        readonly name: string;
        readonly effort?: string;
    };
    readonly nudges?: readonly AgentNudge[];
    readonly instructions: string;
}

/**
 * The agent that is worn when nothing else is.
 *
 * Virtual: every key omitted, so all tools, all skills, the host's own
 * posture, and no pair of its own. Shipping it as a file would make "reset to
 * default" mean "restore a file you may have edited"; shipping it as nothing
 * would leave no bottom to the stack. A file named `default.md` in either
 * scope shadows this, which is what "editable" means.
 */
export const DEFAULT_AGENT: AgentDefinition = {
    name: "default",
    description: "every tool, every skill, the host's own posture",
    instructions: "",
};

const KNOWN_KEYS = new Set([
    "description",
    "tools",
    "skills",
    "posture",
    "forbidden_access",
    "context",
    "default_pair",
    "nudges",
]);

const DEFINITION_KEYS = new Set([
    "name",
    "description",
    "tools",
    "skills",
    "posture",
    "forbiddenAccess",
    "context",
    "defaultPair",
    "nudges",
    "instructions",
]);

export interface ParseAgentOptions {
    /** The names the host will accept for `posture`, when it can say. */
    readonly permissionModes?: readonly string[];
    /**
     * Whether the consumer can show a nudge at all. A spawn cannot, so an
     * agent carrying nudges is a validation error there rather than a silent
     * no-op.
     */
    readonly interactive?: boolean;
}

/**
 * Validates a definition where application code declares it and returns the
 * normalized value. File-backed and module-level definitions share the same
 * field validator so the two forms cannot drift.
 */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
    const value = definition as unknown as Record<string, unknown>;
    for (const key of Object.keys(value)) {
        if (!DEFINITION_KEYS.has(key)) {
            throw new Error(`Agent ${String(value.name)} has an unknown key: ${key}`);
        }
    }
    return validateAgentDefinition({
        name: value.name,
        description: value.description,
        tools: value.tools,
        skills: value.skills,
        posture: value.posture,
        forbiddenAccess: value.forbiddenAccess,
        context: value.context,
        defaultPair: value.defaultPair,
        nudges: value.nudges,
        instructions: value.instructions,
    }, {}, true);
}

export function parseAgentDefinition(
    name: string,
    source: string,
    options: ParseAgentOptions = {},
): AgentDefinition {
    validateAgentName(name);
    if (source.length > MAX_AGENT_BYTES) {
        throw new Error(`Agent ${name} exceeds the ${MAX_AGENT_BYTES}-byte limit`);
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    // A body with no frontmatter is a legal agent: instructions alone, every
    // key omitted, which is the smallest thing worth wearing.
    const frontmatter = match === null ? {} : parseFrontmatter(name, match[1] ?? "");
    const instructions = (match === null ? source : source.slice(match[0].length))
        .trim();

    for (const key of Object.keys(frontmatter)) {
        if (!KNOWN_KEYS.has(key)) {
            throw new Error(`Agent ${name} has an unknown key: ${key}`);
        }
    }
    return validateAgentDefinition({
        name,
        description: frontmatter.description,
        tools: frontmatter.tools,
        skills: frontmatter.skills,
        posture: frontmatter.posture,
        forbiddenAccess: frontmatter.forbidden_access,
        context: frontmatter.context,
        defaultPair: frontmatter.default_pair,
        nudges: frontmatter.nudges,
        instructions,
    }, options, false);
}

interface AgentDefinitionFields {
    readonly name: unknown;
    readonly description: unknown;
    readonly tools: unknown;
    readonly skills: unknown;
    readonly posture: unknown;
    readonly forbiddenAccess: unknown;
    readonly context: unknown;
    readonly defaultPair: unknown;
    readonly nudges: unknown;
    readonly instructions: unknown;
}

function validateAgentDefinition(
    fields: AgentDefinitionFields,
    options: ParseAgentOptions,
    requireInstructions: boolean,
): AgentDefinition {
    const name = validateAgentName(fields.name);
    const instructions = validateInstructions(
        name,
        fields.instructions,
        requireInstructions,
    );
    const context = fields.context;
    if (context !== undefined && context !== "full") {
        throw new Error(
            `Agent ${name}: context ${JSON.stringify(context)} is not yet supported`,
        );
    }

    const description = optionalText(
        name,
        "description",
        fields.description,
        MAX_DESCRIPTION_CHARACTERS,
    );
    const tools = optionalNameList(name, "tools", fields.tools);
    const skills = optionalNameList(name, "skills", fields.skills);
    const posture = optionalText(name, "posture", fields.posture, 64);
    const forbiddenAccess = optionalNameList(
        name,
        "forbidden_access",
        fields.forbiddenAccess,
    );
    if (
        posture !== undefined
        && options.permissionModes !== undefined
        && !options.permissionModes.includes(posture)
    ) {
        throw new Error(`Agent ${name}: no permission mode named ${posture}`);
    }
    if (options.permissionModes !== undefined) {
        const unknown = forbiddenAccess?.find((mode) =>
            !options.permissionModes!.includes(mode)
        );
        if (unknown !== undefined) {
            throw new Error(`Agent ${name}: no permission mode named ${unknown}`);
        }
    }
    const defaultPair = parseDefaultPair(name, fields.defaultPair);
    const nudges = parseNudges(name, fields.nudges);
    if (nudges !== undefined && options.interactive === false) {
        throw new Error(
            `Agent ${name} carries nudges, which only an interactive session can show`,
        );
    }

    return {
        name,
        ...(description === undefined ? {} : { description }),
        ...(tools === undefined ? {} : { tools }),
        ...(skills === undefined ? {} : { skills }),
        ...(posture === undefined ? {} : { posture }),
        ...(forbiddenAccess === undefined ? {} : { forbiddenAccess }),
        ...(context === undefined ? {} : { context: "full" as const }),
        ...(defaultPair === undefined ? {} : { defaultPair }),
        ...(nudges === undefined ? {} : { nudges }),
        instructions,
    };
}

function validateAgentName(value: unknown): string {
    if (typeof value !== "string" || !AGENT_NAME.test(value)) {
        throw new Error(
            `Agent name ${String(value)} must be lowercase letters, numbers and single hyphens`,
        );
    }
    return value;
}

function validateInstructions(
    name: string,
    value: unknown,
    required: boolean,
): string {
    if (typeof value !== "string") {
        throw new Error(`Agent ${name}: instructions must be a string`);
    }
    const instructions = value.trim();
    if (required && instructions.length === 0) {
        throw new Error(`Agent ${name}: instructions must not be empty`);
    }
    if (instructions.length > MAX_AGENT_BYTES) {
        throw new Error(`Agent ${name} exceeds the ${MAX_AGENT_BYTES}-byte limit`);
    }
    return instructions;
}

/** The name an agent file carries, which is the filename without `.md`. */
export function agentNameFromPath(path: string): string {
    return basename(path).replace(/\.md$/i, "");
}

function parseFrontmatter(
    name: string,
    text: string,
): Record<string, unknown> {
    let value: unknown;
    try {
        value = Bun.YAML.parse(text);
    } catch (error) {
        throw new Error(
            `Agent ${name} has invalid frontmatter: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Agent ${name} frontmatter must be a YAML mapping`);
    }
    return value as Record<string, unknown>;
}

function optionalText(
    agent: string,
    key: string,
    value: unknown,
    limit: number,
): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Agent ${agent}: ${key} must be a non-empty string`);
    }
    if (value.length > limit) {
        throw new Error(`Agent ${agent}: ${key} is longer than ${limit} characters`);
    }
    return value.trim();
}

function optionalNameList(
    agent: string,
    key: string,
    value: unknown,
): readonly string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (
        !Array.isArray(value)
        || value.some((entry) =>
            typeof entry !== "string" || entry.trim().length === 0
        )
    ) {
        throw new Error(`Agent ${agent}: ${key} must be a list of names`);
    }
    // An empty list is a real answer: this agent may reach none of them.
    return value.map((entry) => (entry as string).trim());
}

function parseDefaultPair(
    agent: string,
    value: unknown,
): AgentDefinition["defaultPair"] {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Agent ${agent}: default_pair must be a mapping`);
    }
    const pair = value as Record<string, unknown>;
    const name = optionalText(agent, "default_pair.name", pair.name, 128);
    if (name === undefined) {
        throw new Error(`Agent ${agent}: default_pair needs a pool name`);
    }
    const effort = optionalText(agent, "default_pair.effort", pair.effort, 64);
    // An effort-less pair is legal: plenty of models publish no levels, and a
    // default that had to invent one would be a default that cannot apply.
    return { name, ...(effort === undefined ? {} : { effort }) };
}

function parseNudges(
    agent: string,
    value: unknown,
): readonly AgentNudge[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`Agent ${agent}: nudges must be a list`);
    }
    return value.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new Error(`Agent ${agent}: each nudge must be a mapping`);
        }
        const nudge = entry as Record<string, unknown>;
        const on = optionalText(agent, "nudge.on", nudge.on, 128);
        const text = optionalText(agent, "nudge.text", nudge.text, 1024);
        if (on === undefined || text === undefined) {
            throw new Error(
                `Agent ${agent}: a nudge needs both an "on" and a "text"`,
            );
        }
        return { on, text };
    });
}
