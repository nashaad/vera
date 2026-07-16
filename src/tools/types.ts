import type { ModelTool } from "../model/types.ts";
import type { ToolRuntime } from "./runtime.ts";

export interface ToolExecutionResult {
    readonly output: string;
    readonly isError: boolean;
}

export interface RegisteredTool {
    readonly definition: ModelTool;
    execute(
        input: Readonly<Record<string, unknown>>,
        context: ToolRuntime,
        signal: AbortSignal,
    ): Promise<ToolExecutionResult>;
}
