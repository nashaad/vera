import type {
    ModelMessage,
    ModelReasoningEffort,
    ModelRequest,
    ModelTool,
} from "../model/types.ts";
import { projectSystemPrompt } from "./assemble.ts";
import {
    projectInstructionMetadata,
    type ProjectInstructionMetadata,
    type ProjectInstructionSnapshot,
} from "./project-instructions.ts";
import type { PromptContribution } from "./prompt-contributions.ts";

export interface ModelRequestSnapshot {
    readonly provider?: string;
    readonly model: string;
    readonly maxTokens: number;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly date: Date;
    readonly projectInstructions: ProjectInstructionSnapshot;
    readonly signal: AbortSignal;
}

export interface ProjectedModelRequest extends Omit<ModelRequest, "messages"> {
    readonly maxTokens: number;
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
    readonly projectInstructions: ProjectInstructionMetadata;
}

export interface ModelRequestProjection {
    readonly request: ProjectedModelRequest;
    readonly promptContributions: readonly PromptContribution[];
}

export function buildModelRequest(
    snapshot: ModelRequestSnapshot,
): ProjectedModelRequest {
    return projectModelRequest(snapshot).request;
}

export function projectModelRequest(
    snapshot: ModelRequestSnapshot,
): ModelRequestProjection {
    const messages = Object.freeze([...snapshot.messages]);
    const tools = Object.freeze([...snapshot.tools]);
    const prompt = projectSystemPrompt({
        tools,
        workspace: snapshot.workspace,
        date: snapshot.date,
        projectInstructions: snapshot.projectInstructions,
    });
    const request = Object.freeze({
        ...(snapshot.provider === undefined ? {} : { provider: snapshot.provider }),
        model: snapshot.model,
        maxTokens: snapshot.maxTokens,
        ...(snapshot.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: snapshot.reasoningEffort }),
        systemPrompt: prompt.systemPrompt,
        messages,
        tools,
        projectInstructions: projectInstructionMetadata(
            snapshot.projectInstructions,
        ),
        signal: snapshot.signal,
    });
    return Object.freeze({
        request,
        promptContributions: prompt.contributions,
    });
}
