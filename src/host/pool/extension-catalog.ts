import type { ExtensionCommandDescriptor, ExtensionCommandResult } from "../../extensions/commands.ts";
import type { ExtensionRegisteredTool, ExtensionRegistry } from "../../extensions/registry.ts";
import { ToolRuntime } from "../../tools/runtime.ts";
import type { RegisteredTool, ToolExecutionResult } from "../../tools/types.ts";
import type { ControlChannel } from "./control.ts";

export const HOST_EXTENSION_IDS: ReadonlySet<string> = new Set(["vera.mcp"]);

export interface CatalogTool {
    readonly extensionId: string;
    readonly tool: Omit<RegisteredTool, "execute">;
}

export interface ExtensionCatalog {
    readonly extensionOrder: readonly string[];
    readonly toolCatalog: readonly CatalogTool[];
    readonly commandCatalog: readonly ExtensionCommandDescriptor[];
}

export interface WorkerExtensionServices {
    readonly catalog: ExtensionCatalog;
    readonly tools: readonly ExtensionRegisteredTool[];
    invokeCommand(
        name: string, argumentsText: string, workspace: string, signal: AbortSignal,
        sessionId?: string, sessionPath?: string,
    ): Promise<ExtensionCommandResult>;
}

export function buildExtensionCatalog(registry: ExtensionRegistry): ExtensionCatalog {
    return {
        extensionOrder: registry.extensionIds(),
        toolCatalog: registry.toolsByExtension()
            .filter(({ extensionId }) => HOST_EXTENSION_IDS.has(extensionId))
            .map(({ extensionId, tool }) => ({ extensionId, tool: toolMetadata(tool) })),
        commandCatalog: registry.commands().filter((command) => HOST_EXTENSION_IDS.has(command.source)),
    };
}

export function remoteExtensions(peer: ControlChannel, catalog: ExtensionCatalog): WorkerExtensionServices {
    return {
        catalog,
        tools: catalog.toolCatalog.map(({ extensionId, tool }) => ({
            extensionId,
            tool: {
                ...tool,
                execute: (input, context, signal) => peer.request<ToolExecutionResult>(
                    "extension.executeTool",
                    [tool.definition.name, input, {
                        workspace: context.workspace,
                        isSubagent: context.isSubagent,
                        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
                    }],
                    signal,
                ),
            },
        })),
        invokeCommand: (name, argumentsText, workspace, signal, sessionId, sessionPath) =>
            peer.request("extension.invokeCommand", [name, argumentsText, workspace, sessionId, sessionPath], signal),
    };
}

export function orderByExtension<T>(
    order: readonly string[], values: readonly T[], owner: (value: T) => string,
): T[] {
    const positions = new Map(order.map((id, index) => [id, index]));
    return [...values].sort((left, right) =>
        (positions.get(owner(left)) ?? order.length) - (positions.get(owner(right)) ?? order.length));
}

export async function serveExtensionRequest(
    registry: ExtensionRegistry, method: string, args: readonly unknown[], signal: AbortSignal,
): Promise<unknown> {
    if (method === "extension.executeTool") {
        const [name, input, context] = args;
        if (typeof name !== "string" || !record(input) || !record(context)
            || typeof context.workspace !== "string" || typeof context.isSubagent !== "boolean"
            || (context.sessionId !== undefined && typeof context.sessionId !== "string")) {
            throw new Error("Invalid extension tool request");
        }
        const registered = registry.toolsByExtension().find(({ extensionId, tool }) =>
            HOST_EXTENSION_IDS.has(extensionId) && tool.definition.name === name);
        if (registered === undefined) throw new Error("Host extension tool is unavailable");
        const runtime = new ToolRuntime(context.workspace, undefined, undefined, undefined, undefined, undefined, context.isSubagent);
        runtime.sessionId = context.sessionId as string | undefined;
        try { return await registered.tool.execute(input, runtime, signal); }
        finally { await runtime.close(); }
    }
    if (method === "extension.invokeCommand") {
        const [name, argumentsText, workspace, sessionId, sessionPath] = args;
        if (typeof name !== "string" || typeof argumentsText !== "string" || typeof workspace !== "string"
            || (sessionId !== undefined && typeof sessionId !== "string")
            || (sessionPath !== undefined && typeof sessionPath !== "string")) {
            throw new Error("Invalid extension command request");
        }
        const command = registry.commands().find((entry) =>
            HOST_EXTENSION_IDS.has(entry.source) && entry.name === name);
        if (command === undefined) throw new Error("Host extension command is unavailable");
        return await registry.invokeCommand(name, argumentsText, workspace, signal, sessionId, sessionPath);
    }
    throw new Error("Unknown extension control request");
}

function toolMetadata(tool: RegisteredTool): Omit<RegisteredTool, "execute"> {
    return {
        definition: tool.definition,
        ...(tool.invocation === undefined ? {} : { invocation: tool.invocation }),
        ...(tool.parallel === undefined ? {} : { parallel: tool.parallel }),
        ...(tool.effectType === undefined ? {} : { effectType: tool.effectType }),
        ...(tool.permissionOperation === undefined ? {} : { permissionOperation: tool.permissionOperation }),
        ...(tool.requiresUserInteraction === undefined ? {} : { requiresUserInteraction: tool.requiresUserInteraction }),
        ...(tool.permissionInputs === undefined ? {} : { permissionInputs: tool.permissionInputs }),
    };
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
