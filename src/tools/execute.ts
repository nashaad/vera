import type {
    ModelTool,
    ToolCallContent,
    ToolResultMessage,
} from "../model/types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool, writeTool } from "./files.ts";
import type { ToolRuntime } from "./runtime.ts";
import { subagentTool } from "./subagent.ts";
import type {
    RegisteredTool,
    ToolEffect,
    ToolExecutionResult,
    ToolOutput,
} from "./types.ts";
import { backgroundAgentTool } from "./background-agent.ts";

const ordinaryTools: readonly RegisteredTool[] = [
    bashTool,
    readTool,
    writeTool,
    editTool,
];
const registeredTools: readonly RegisteredTool[] = [
    ...ordinaryTools,
    subagentTool,
    backgroundAgentTool,
];
const toolRegistry = new Map(
    registeredTools.map((tool) => [tool.definition.name, tool] as const),
);

export function toolDefinitionsForEffects(
    enabledEffects: readonly ToolEffect["type"][],
): readonly ModelTool[] {
    const enabled = new Set(enabledEffects);
    return registeredTools
        .filter((tool) =>
            tool.effectType === undefined || enabled.has(tool.effectType)
        )
        .map((tool) => tool.definition);
}

export function toolMayRunInParallel(name: string): boolean {
    return toolRegistry.get(name)?.parallel === true;
}

export async function executeToolCall(
    toolCall: ToolCallContent,
    runtime: ToolRuntime,
    signal: AbortSignal = new AbortController().signal,
): Promise<ToolResultMessage> {
    const execution = await executeToolHandler(toolCall, runtime, signal);
    const output = execution.kind === "output"
        ? execution
        : errorOutput("Tool effects are not enabled in this agent");
    return toolResultMessage(toolCall, output);
}

export async function executeToolHandler(
    toolCall: ToolCallContent,
    runtime: ToolRuntime,
    signal: AbortSignal,
): Promise<ToolExecutionResult> {
    const tool = toolRegistry.get(toolCall.name);
    if (tool === undefined) {
        return errorOutput(`Unknown tool: ${toolCall.name}`);
    }

    try {
        signal.throwIfAborted();
        return await tool.execute(toolCall.input, runtime, signal);
    } catch (error) {
        return errorOutput(error instanceof Error ? error.message : String(error));
    }
}

export function toolResultMessage(
    toolCall: ToolCallContent,
    result: ToolOutput,
): ToolResultMessage {
    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: result.output }],
        isError: result.isError,
    };
}

function errorOutput(output: string): ToolOutput {
    return { kind: "output", output, isError: true };
}
