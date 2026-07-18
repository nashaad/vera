import type { ModelTool } from "../model/types.ts";
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

export interface ToolEffectRequest {
    readonly kind: "effect";
    readonly effect: ToolEffect;
}

export type ApplyToolEffect = (
    effect: ToolEffect,
    signal: AbortSignal,
) => Promise<ToolOutput>;

// Tools either finish with text or ask the engine owner to apply an effect.
// Effects stay plain data: live loops, stores, and AbortControllers never cross
// this boundary.
export type ToolExecutionResult = ToolOutput | ToolEffectRequest;

export interface RegisteredTool {
    readonly definition: ModelTool;
    readonly parallel?: boolean;
    readonly effectType?: ToolEffect["type"];
    execute(
        input: Readonly<Record<string, unknown>>,
        context: ToolRuntime,
        signal: AbortSignal,
    ): Promise<ToolExecutionResult>;
}
