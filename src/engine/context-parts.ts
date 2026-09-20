import { basename } from "node:path";

import { PROJECT_INSTRUCTION_FILENAMES } from "./project-instructions.ts";
import type { MemorySnapshot } from "./memory.ts";
import type { ProjectInstructionSnapshot } from "./project-instructions.ts";
import { alwaysOnRules, type RuleScope, type RuleSnapshot } from "./rules.ts";

export type ContextPartScope =
    | "project"
    | "user"
    | "agent"
    | "memory"
    | "skill";

export interface ContextPartSeed {
    readonly id: string;
    readonly displayName: string;
    readonly scope: ContextPartScope;
    readonly bytes: number;
    readonly imported?: boolean;
}

export interface ContextProjectionPart {
    readonly id: string;
    readonly displayName: string;
    readonly scope: ContextPartScope;
    readonly bytes: number;
    readonly estimatedTokens: number;
    readonly imported?: boolean;
}

export function contextContributionParts(input: {
    readonly projectInstructions?: ProjectInstructionSnapshot;
    readonly rules?: RuleSnapshot;
    readonly memory?: MemorySnapshot;
    readonly agentName?: string;
    readonly agentInstructions?: string;
}): Readonly<Record<string, readonly ContextPartSeed[]>> {
    const parts: Record<string, readonly ContextPartSeed[]> = {};
    const project = projectInstructionParts(input.projectInstructions);
    if (project.length > 0) {
        parts["core.project-instructions"] = project;
    }
    for (const scope of ["user", "project"] as const) {
        const seeds = ruleParts(input.rules, scope);
        if (seeds.length > 0) {
            parts[`core.${scope}-rules`] = seeds;
        }
    }
    const memory = memoryParts(input.memory);
    if (memory.length > 0) {
        parts["core.memory"] = memory;
    }
    const agent = agentParts(input.agentName, input.agentInstructions);
    if (agent.length > 0) {
        parts["core.agent-instructions"] = agent;
    }
    return parts;
}

export function apportionPartTokens(
    seeds: readonly ContextPartSeed[],
    tokens: number,
): readonly ContextProjectionPart[] {
    if (seeds.length === 0) return [];
    const totalBytes = seeds.reduce((sum, seed) => sum + seed.bytes, 0);
    let assigned = 0;
    return seeds.map((seed, index) => {
        const estimatedTokens = index === seeds.length - 1
            ? Math.max(0, tokens - assigned)
            : totalBytes === 0
                ? 0
                : Math.floor(tokens * seed.bytes / totalBytes);
        assigned += estimatedTokens;
        return {
            id: seed.id,
            displayName: seed.displayName,
            scope: seed.scope,
            bytes: seed.bytes,
            estimatedTokens,
            ...(seed.imported === true ? { imported: true } : {}),
        };
    });
}

function projectInstructionParts(
    snapshot: ProjectInstructionSnapshot | undefined,
): readonly ContextPartSeed[] {
    if (snapshot === undefined) return [];
    return snapshot.files.map((file) => ({
        id: file.path,
        displayName: file.name,
        scope: "project",
        bytes: file.bytes,
        ...(isRootInstructionName(file.name) ? {} : { imported: true }),
    }));
}

function ruleParts(
    snapshot: RuleSnapshot | undefined,
    scope: RuleScope,
): readonly ContextPartSeed[] {
    if (snapshot === undefined) return [];
    return alwaysOnRules(snapshot.rules, scope).map((rule) => ({
        id: rule.path,
        displayName: rule.displayPath,
        scope,
        bytes: Buffer.byteLength(rule.body, "utf8"),
    }));
}

function memoryParts(
    snapshot: MemorySnapshot | undefined,
): readonly ContextPartSeed[] {
    if (snapshot === undefined) return [];
    const files = snapshot.files.map((file) => ({
        id: file.path,
        displayName: "MEMORY.md",
        scope: "memory" as const,
        bytes: file.bytes,
    }));
    const topics = snapshot.loadedTopics.map((topic) => ({
        id: `${topic.scope}:${topic.file}`,
        displayName: topic.file,
        scope: "memory" as const,
        bytes: topic.bytes,
        imported: true,
    }));
    return [...files, ...topics];
}

function agentParts(
    agentName: string | undefined,
    instructions: string | undefined,
): readonly ContextPartSeed[] {
    const body = instructions?.trim() ?? "";
    if (body.length === 0) return [];
    return [{
        id: `agent:${agentName ?? "default"}`,
        displayName: agentName ?? "default",
        scope: "agent",
        bytes: Buffer.byteLength(body, "utf8"),
    }];
}

function isRootInstructionName(name: string): boolean {
    return (PROJECT_INSTRUCTION_FILENAMES as readonly string[])
        .includes(basename(name));
}
