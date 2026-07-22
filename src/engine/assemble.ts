import type { ModelTool } from "../model/types.ts";
import type { ProjectInstructionSnapshot } from "./project-instructions.ts";
import {
    collectContextualPromptContributions,
    collectStablePromptContributions,
    type PromptContribution,
} from "./prompt-contributions.ts";

// Prompt ordering is a provider KV-cache contract. Treat prefix stability as
// a gate for every change here: stable content must remain byte-identical and
// mutable content belongs at the growing edge.

export interface AssembleSystemPromptInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
}

export interface AssembleStableSystemPromptInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
}

export interface AssembleContextualSystemPromptInput {
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
}

export function assembleSystemPrompt(
    input: AssembleSystemPromptInput,
): string {
    return [
        assembleStableSystemPrompt(input),
        assembleContextualSystemPrompt(input),
    ].join("\n\n");
}

export function assembleStableSystemPrompt(
    input: AssembleStableSystemPromptInput,
): string {
    return renderContributions(collectStablePromptContributions(input));
}

export function assembleContextualSystemPrompt(
    input: AssembleContextualSystemPromptInput,
): string {
    return renderContributions(collectContextualPromptContributions(input));
}

function renderContributions(
    contributions: readonly PromptContribution[],
): string {
    return contributions.map((contribution) =>
        `## ${contribution.title}\n${contribution.content}`
    ).join("\n\n");
}
