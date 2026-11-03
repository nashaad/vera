import { isBuiltInToolName } from "../tools/execute.ts";
import type { RegisteredTool } from "../tools/types.ts";

/** A caller function the model may call during `agent.run()`. */
export interface FunctionTool {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments object. */
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly run: (
        args: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ) => string | Promise<string>;
}

export const FUNCTION_CALL_OPERATION = "function.call";

const FUNCTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function checkFunctionTools(
    functions: readonly FunctionTool[],
): readonly FunctionTool[] {
    const names = new Set<string>();
    for (const tool of functions) {
        if (typeof tool.name !== "string" || !FUNCTION_NAME.test(tool.name)) {
            throw new Error(
                `Function name ${JSON.stringify(tool.name)} must be lowercase snake_case, at most 64 characters`,
            );
        }
        if (isBuiltInToolName(tool.name)) {
            throw new Error(`Function ${tool.name} collides with a built-in tool`);
        }
        if (names.has(tool.name)) {
            throw new Error(`Duplicate function: ${tool.name}`);
        }
        names.add(tool.name);
        if (typeof tool.description !== "string") {
            throw new Error(`Function ${tool.name} needs a description string`);
        }
        if (!isObjectSchema(tool.parameters)) {
            throw new Error(
                `Function ${tool.name} parameters must be a JSON Schema with type "object"`,
            );
        }
        if (typeof tool.run !== "function") {
            throw new Error(`Function ${tool.name} needs a run function`);
        }
    }
    return functions;
}

export function registeredFunctionTool(tool: FunctionTool): RegisteredTool {
    return {
        definition: {
            name: tool.name,
            description: tool.description.trim(),
            inputSchema: structuredClone(tool.parameters),
        },
        permissionOperation: FUNCTION_CALL_OPERATION,
        async execute(input, _context, signal) {
            try {
                const output = await tool.run(structuredClone(input), signal);
                if (typeof output !== "string") {
                    return {
                        kind: "output",
                        output: `Function ${tool.name} returned ${typeof output}, not a string`,
                        isError: true,
                    };
                }
                return { kind: "output", output, isError: false };
            } catch (caught) {
                return {
                    kind: "output",
                    output: caught instanceof Error ? caught.message : String(caught),
                    isError: true,
                };
            }
        },
    };
}

function isObjectSchema(value: unknown): boolean {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && (value as Record<string, unknown>).type === "object";
}
