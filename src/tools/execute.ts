import type {
    ModelTool,
    ToolCallContent,
    ToolResultMessage,
} from "../model/types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool, writeTool } from "./files.ts";
import type { ToolRuntime } from "./runtime.ts";
import type { RegisteredTool } from "./types.ts";

const registeredTools: readonly RegisteredTool[] = [
    bashTool,
    readTool,
    writeTool,
    editTool,
];
const toolRegistry = new Map(
    registeredTools.map((tool) => [tool.definition.name, tool] as const),
);

export const availableTools: readonly ModelTool[] = registeredTools.map(
    (tool) => tool.definition,
);

export async function executeToolCall(
    toolCall: ToolCallContent,
    runtime: ToolRuntime,
    signal: AbortSignal = new AbortController().signal,
): Promise<ToolResultMessage> {
    const tool = toolRegistry.get(toolCall.name);
    let output = `Unknown tool: ${toolCall.name}`;
    let isError = true;

    if (tool !== undefined) {
        try {
            signal.throwIfAborted();
            const result = await tool.execute(toolCall.input, runtime, signal);
            output = result.output;
            isError = result.isError;
        } catch (error) {
            output = error instanceof Error ? error.message : String(error);
            isError = true;
        }
    }

    return {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: output }],
        isError,
    };
}
