/**
 * Where agents come from, and which one wins when two share a name.
 *
 * Three sources, in decreasing precedence: the project, the user's profile,
 * and whatever extensions registered. A collision is a notice rather than an
 * error — a project agent shadowing a personal one is the normal way to say
 * "here, use this one".
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
    agentNameFromPath,
    DEFAULT_AGENT,
    parseAgentDefinition,
    type AgentDefinition,
    type ParseAgentOptions,
} from "./definition.ts";
import { veraProfileDirectory } from "../profile-paths.ts";

export type AgentScope = "project" | "user" | "extension";

export interface CatalogAgent {
    readonly definition: AgentDefinition;
    readonly scope: AgentScope;
    /** Where it was read from. Absent for an extension's registration. */
    readonly path?: string;
    /** Extension-registered agents are read-only: the writer refuses them. */
    readonly writable: boolean;
}

export interface AgentCatalog {
    readonly agents: readonly CatalogAgent[];
    readonly notices: readonly string[];
}

/**
 * Profile-scoped, like skills and memory. `$VERA_HOME/agents` would be
 * machine-wide and would step straight past whichever profile is in use.
 */
export function userAgentDirectory(): string {
    return join(veraProfileDirectory(), "agents");
}

/** Parallel to project skills, discovered the same way from the same root. */
export function projectAgentDirectory(projectRoot: string): string {
    return join(projectRoot, ".vera", "agents");
}

export interface LoadAgentCatalogOptions extends ParseAgentOptions {
    readonly projectRoot: string;
    readonly userDirectory?: string;
    readonly projectDirectory?: string;
    /** Agents an extension registered at activation, lowest precedence. */
    readonly registered?: readonly AgentDefinition[];
}

export async function loadAgentCatalog(
    options: LoadAgentCatalogOptions,
): Promise<AgentCatalog> {
    const notices: string[] = [];
    const byName = new Map<string, CatalogAgent>();

    for (const definition of options.registered ?? []) {
        byName.set(definition.name, {
            definition,
            scope: "extension",
            writable: false,
        });
    }
    // Later roots win, so they are read in increasing precedence.
    for (
        const root of [
            {
                scope: "user" as const,
                path: options.userDirectory ?? userAgentDirectory(),
            },
            {
                scope: "project" as const,
                path: options.projectDirectory
                    ?? projectAgentDirectory(options.projectRoot),
            },
        ]
    ) {
        for (const agent of await readRoot(root.path, root.scope, notices, options)) {
            const previous = byName.get(agent.definition.name);
            if (previous !== undefined) {
                notices.push(
                    `agent ${agent.definition.name}: ${root.scope} definition shadows the ${previous.scope} one`,
                );
            }
            byName.set(agent.definition.name, agent);
        }
    }

    if (!byName.has(DEFAULT_AGENT.name)) {
        byName.set(DEFAULT_AGENT.name, {
            definition: DEFAULT_AGENT,
            scope: "extension",
            writable: false,
        });
    }
    return {
        agents: [...byName.values()].sort((left, right) =>
            left.definition.name < right.definition.name ? -1 : 1
        ),
        notices,
    };
}

export function findCatalogAgent(
    catalog: AgentCatalog,
    name: string,
): CatalogAgent | undefined {
    return catalog.agents.find((agent) => agent.definition.name === name);
}

async function readRoot(
    directory: string,
    scope: AgentScope,
    notices: string[],
    options: ParseAgentOptions,
): Promise<readonly CatalogAgent[]> {
    let names: readonly string[];
    try {
        names = await readdir(directory);
    } catch {
        // No directory is the ordinary case, not a problem to report.
        return [];
    }
    const agents: CatalogAgent[] = [];
    for (const entry of names.filter((name) => name.endsWith(".md")).sort()) {
        const path = join(directory, entry);
        try {
            const source = await readFile(path, "utf8");
            agents.push({
                definition: parseAgentDefinition(
                    agentNameFromPath(entry),
                    source,
                    options,
                ),
                scope,
                path,
                writable: true,
            });
        } catch (error) {
            // A broken agent file is named and skipped. Refusing to start
            // because one agent has a typo would take the other agents with it.
            notices.push(
                `agent ${path}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    return agents;
}
