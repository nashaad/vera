import type { ModelReasoningEffort, ModelTool } from "../model/types.ts";
import type { ApprovalMode } from "../sdk/permissions.ts";
import type { ToolRuntime } from "./runtime.ts";

export interface ToolOutput {
    readonly kind: "output";
    readonly output: string;
    readonly isError: boolean;
}

export interface SpawnSubagentEffect {
    readonly type: "spawn_subagent";
    readonly description: string;
}

export interface SpawnBackgroundAgentEffect {
    readonly type: "spawn_background_agent";
    readonly description: string;
}

export type ToolEffect = SpawnSubagentEffect | SpawnBackgroundAgentEffect;

export interface AskUserChoice {
    readonly id: string;
    readonly label: string;
}

export interface AskUserInteraction {
    readonly type: "ask_user";
    readonly question: string;
    readonly choices: readonly AskUserChoice[];
}

export interface ToolEffectContext {
    readonly approvalMode: ApprovalMode;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ToolEffectRequest {
    readonly kind: "effect";
    readonly effect: ToolEffect;
}

export interface ToolInteractionRequest {
    readonly kind: "interaction";
    readonly interaction: AskUserInteraction;
}

export type ApplyToolEffect = (
    effect: ToolEffect,
    signal: AbortSignal,
    context: ToolEffectContext,
) => Promise<ToolOutput>;

// Tools either finish with text or return a plain-data request for the engine
// owner to resolve. Live loops, stores, UI objects, and AbortControllers never
// cross this boundary.
export type ToolExecutionResult =
    | ToolOutput
    | ToolEffectRequest
    | ToolInteractionRequest;

export interface RegisteredTool {
    readonly definition: ModelTool;
    readonly parallel?: boolean;
    readonly effectType?: ToolEffect["type"];
    readonly requiresUserInteraction?: boolean;
    execute(
        input: Readonly<Record<string, unknown>>,
        context: ToolRuntime,
        signal: AbortSignal,
    ): Promise<ToolExecutionResult>;
}
