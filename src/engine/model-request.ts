import type {
    ModelMessage,
    ModelReasoningEffort,
    ModelRequest,
    ModelTool,
} from "../model/types.ts";
import { assembleSystemPrompt } from "./assemble.ts";
import {
    projectInstructionMetadata,
    type ProjectInstructionMetadata,
    type ProjectInstructionSnapshot,
} from "./project-instructions.ts";

export interface ModelRequestSnapshot {
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

export interface ProjectedModelRequest extends ModelRequest {
    readonly maxTokens: number;
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
    readonly projectInstructions: ProjectInstructionMetadata;
}

export function buildModelRequest(
    snapshot: ModelRequestSnapshot,
): ProjectedModelRequest {
    const messages = Object.freeze([...snapshot.messages]);
    const tools = Object.freeze([...snapshot.tools]);
    return Object.freeze({
        model: snapshot.model,
        maxTokens: snapshot.maxTokens,
        ...(snapshot.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: snapshot.reasoningEffort }),
        systemPrompt: assembleSystemPrompt({
            tools,
            workspace: snapshot.workspace,
            date: snapshot.date,
            projectInstructions: snapshot.projectInstructions,
        }),
        messages,
        tools,
        projectInstructions: projectInstructionMetadata(
            snapshot.projectInstructions,
        ),
        signal: snapshot.signal,
    });
}
