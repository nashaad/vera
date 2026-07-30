import type {
    ModelTool,
    ToolCallContent,
    ToolResultMessage,
} from "../model/types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool, writeTool } from "./files.ts";
import { grepTool } from "./grep.ts";
import { listTool } from "./list.ts";
import type { ToolRuntime } from "./runtime.ts";
import { subagentTool } from "./subagent.ts";
import { askUserTool } from "./ask-user.ts";
import type {
    PermissionInputSpec,
    RegisteredTool,
    ToolEffect,
    ToolExecutionResult,
    ToolOutput,
} from "./types.ts";
import { asyncSubagentTool } from "./async-subagent.ts";
import { messageSubagentTool } from "./message-subagent.ts";
import { notifyParentTool } from "./notify-parent.ts";
import { webFetchTool } from "./web-fetch.ts";

const ordinaryTools: readonly RegisteredTool[] = [
    bashTool,
    readTool,
    writeTool,
    editTool,
    grepTool,
    listTool,
    webFetchTool,
];
const registeredTools: readonly RegisteredTool[] = [
    ...ordinaryTools,
    askUserTool,
    subagentTool,
    asyncSubagentTool,
    messageSubagentTool,
    notifyParentTool,
];
for (const tool of registeredTools) {
    assertValidPermissionInputs(tool);
}
const toolRegistry = new Map(
    registeredTools.map((tool) => [tool.definition.name, tool] as const),
);

export function isBuiltInToolName(name: string): boolean {
    return toolRegistry.has(name);
}

function toolFor(
    name: string,
    extensionTools: readonly RegisteredTool[] = [],
): RegisteredTool | undefined {
    return toolRegistry.get(name)
        ?? extensionTools.find((tool) => tool.definition.name === name);
}

/**
 * The path/URL inputs a registered tool declared for permission gating, or
 * `undefined` for a tool that declared none (its call becomes an `unknown`
 * action, same as an unrecognized bash command).
 */
export function toolPermissionInputs(
    name: string,
    extensionTools: readonly RegisteredTool[] = [],
): readonly PermissionInputSpec[] | undefined {
    return toolFor(name, extensionTools)?.permissionInputs;
}

export function toolPermissionOperation(
    name: string,
    extensionTools: readonly RegisteredTool[] = [],
): string | undefined {
    return toolFor(name, extensionTools)?.permissionOperation;
}

function assertValidPermissionInputs(tool: RegisteredTool): void {
    const properties = inputSchemaProperties(tool.definition.inputSchema);
    for (const spec of tool.permissionInputs ?? []) {
        const property = properties?.[spec.field];
        if (
            typeof property !== "object"
            || property === null
            || (property as Record<string, unknown>).type !== "string"
        ) {
            throw new Error(
                `Tool ${tool.definition.name} declares permission input `
                    + `"${spec.field}" that is not a string field in its `
                    + "input schema",
            );
        }
    }
}

function inputSchemaProperties(
    schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
    const properties = schema.properties;
    return typeof properties === "object" && properties !== null
        ? properties as Readonly<Record<string, unknown>>
        : undefined;
}

export function toolDefinitionsForCapabilities(
    enabledEffects: readonly ToolEffect["type"][],
    enableUserInteraction = false,
    extensionTools: readonly RegisteredTool[] = [],
): readonly ModelTool[] {
    const enabled = new Set(enabledEffects);
    return [...registeredTools, ...extensionTools]
        .filter((tool) =>
            (tool.effectType === undefined || enabled.has(tool.effectType))
            && (
                tool.requiresUserInteraction !== true
                || enableUserInteraction
            )
        )
        .map((tool) => tool.definition);
}

export function toolMayRunInParallel(
    name: string,
    extensionTools: readonly RegisteredTool[] = [],
): boolean {
    return toolFor(name, extensionTools)?.parallel === true;
}

export async function executeToolCall(
    toolCall: ToolCallContent,
    runtime: ToolRuntime,
    signal: AbortSignal = new AbortController().signal,
): Promise<ToolResultMessage> {
    const execution = await executeToolHandler(toolCall, runtime, signal);
    const output = execution.kind === "output"
        ? execution
        : execution.kind === "interaction"
            ? errorOutput("User interaction is not enabled in this agent")
            : errorOutput("Tool effects are not enabled in this agent");
    return toolResultMessage(toolCall, output);
}

export async function executeToolHandler(
    toolCall: ToolCallContent,
    runtime: ToolRuntime,
    signal: AbortSignal,
    extensionTools: readonly RegisteredTool[] = [],
): Promise<ToolExecutionResult> {
    const tool = toolFor(toolCall.name, extensionTools);
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
        ...(result.presentation === undefined
            ? {}
            : { presentation: result.presentation }),
    };
}

function errorOutput(output: string): ToolOutput {
    return { kind: "output", output, isError: true };
}
