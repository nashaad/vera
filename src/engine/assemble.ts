import type { ModelTool } from "../model/types.ts";
import type { MemorySnapshot } from "./memory.ts";
import type { ProjectInstructionSnapshot } from "./project-instructions.ts";
import type { ScratchStateSnapshot } from "./scratch-state.ts";
import {
    collectBuiltInPromptContributions,
    collectContextualPromptContributions,
    collectStablePromptContributions,
    type PromptContribution,
    renderPromptContribution,
} from "./prompt-contributions.ts";

export interface AssembleSystemPromptInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
    readonly memory?: MemorySnapshot;
    readonly scratchState?: ScratchStateSnapshot;
    readonly disabledContributions?: readonly string[];
    readonly additionalContextualContributions?: readonly PromptContribution[];
    readonly agentInstructions?: string;
}

export interface AssembleStableSystemPromptInput {
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly disabledContributions?: readonly string[];
    readonly agentInstructions?: string;
}

export interface AssembleContextualSystemPromptInput {
    readonly date: Date;
    readonly projectInstructions?: ProjectInstructionSnapshot;
    readonly memory?: MemorySnapshot;
    readonly scratchState?: ScratchStateSnapshot;
    readonly disabledContributions?: readonly string[];
    readonly additionalContributions?: readonly PromptContribution[];
}

export interface SystemPromptProjection {
    readonly systemPrompt: string;
    readonly contributions: readonly PromptContribution[];
}

export function assembleSystemPrompt(
    input: AssembleSystemPromptInput,
): string {
    return projectSystemPrompt(input).systemPrompt;
}

export function projectSystemPrompt(
    input: AssembleSystemPromptInput,
): SystemPromptProjection {
    const collected = Object.freeze(
        collectBuiltInPromptContributions(input).map((entry) =>
            Object.freeze(entry)
        ),
    );
    const stable = collected.filter((entry) => entry.target === "stable");
    const contextual = collected.filter((entry) =>
        entry.target === "contextual"
    );
    const contributions = Object.freeze([...stable, ...contextual]);
    return {
        systemPrompt: [
            renderContributions(stable),
            renderContributions(contextual),
        ].join("\n\n"),
        contributions,
    };
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
    return contributions.map(renderPromptContribution).join("\n\n");
}
