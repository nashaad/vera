import type { ModelTool } from "../model/types.ts";

export interface ToolExecutionContext {
    readonly workspace: string;
}

export interface ToolExecutionResult {
    readonly output: string;
    readonly isError: boolean;
}

export interface RegisteredTool {
    readonly definition: ModelTool;
    execute(
        input: Readonly<Record<string, unknown>>,
        context: ToolExecutionContext,
    ): Promise<ToolExecutionResult>;
}
