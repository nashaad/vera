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
import type { ScratchStateSnapshot } from "./scratch-state.ts";

export interface ModelRequestSnapshot {
    readonly provider?: string;
    readonly model: string;
    readonly maxTokens: number;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
    readonly workspace: string;
    readonly scratchDir?: string;
    readonly date: Date;
    readonly projectInstructions: ProjectInstructionSnapshot;
    readonly scratchState?: ScratchStateSnapshot;
    readonly disabledPromptContributions?: readonly string[];
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
    const messages = Object.freeze(snapshot.messages
        .filter(isReplayableModelMessage)
        .map(
            (message): ModelMessage => {
                if (message.role !== "tool_result") return message;
                return {
                    role: "tool_result",
                    toolCallId: message.toolCallId,
                    toolName: message.toolName,
                    content: message.content,
                    isError: message.isError,
                };
            },
        ));
    const tools = Object.freeze([...snapshot.tools]);
    const prompt = projectSystemPrompt({
        tools,
        workspace: snapshot.workspace,
        ...(snapshot.scratchDir === undefined
            ? {}
            : { scratchDir: snapshot.scratchDir }),
        date: snapshot.date,
        projectInstructions: snapshot.projectInstructions,
        ...(snapshot.scratchState === undefined
            ? {}
            : { scratchState: snapshot.scratchState }),
        ...(snapshot.disabledPromptContributions === undefined
            ? {}
            : {
                disabledContributions: snapshot.disabledPromptContributions,
            }),
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

/**
 * Terminal failures stay in the durable transcript, but a provider cannot be
 * given an assistant message with no content. Replaying one poisons every
 * later request in the session even though the user can otherwise continue.
 */
function isReplayableModelMessage(message: ModelMessage): boolean {
    if (message.role !== "assistant") {
        return true;
    }
    return message.content.some((block) => {
        if (block.type === "tool_call") {
            return true;
        }
        if (block.type === "thinking") {
            return block.text.length > 0 || block.signature !== undefined;
        }
        return block.text.length > 0;
    });
}
