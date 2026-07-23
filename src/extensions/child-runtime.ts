import { Console } from "node:console";
import { pathToFileURL } from "node:url";

import {
    createExtensionRpcPeer,
    ExtensionRpcHandlerError,
    EXTENSION_RPC_VERSION,
    type ExtensionRpcPeer,
} from "./rpc.ts";
import type {
    VeraExtensionApi,
    VeraExtensionCommandHandler,
    VeraExtensionCommandSpec,
    VeraExtensionDisposer,
    VeraExtensionModule,
} from "../sdk/extensions.ts";
import type { JsonValue } from "../sdk/hooks.ts";
import {
    isExtensionCommandName,
    parseExtensionCommandBody,
    type ExtensionCommandDeclaration,
} from "./commands.ts";

interface ActivateParams {
    readonly rpcVersion: number;
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly capabilities: readonly string[];
    readonly config: JsonValue;
    readonly workspace: string;
}

interface ChildRuntime {
    readonly peer: ExtensionRpcPeer;
}

type LifecyclePhase =
    | "idle"
    | "activating"
    | "active"
    | "failed"
    | "disposing"
    | "disposed";

export function runExtensionChildRuntime(
    entrypointPath: string,
): ChildRuntime {
    redirectConsoleToStderr();

    let phase: LifecyclePhase = "idle";
    let activation: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    const disposers: VeraExtensionDisposer[] = [];
    const commandHandlers = new Map<string, VeraExtensionCommandHandler>();
    const commandNames = new Set<string>();
    const declarations: ExtensionCommandDeclaration[] = [];
    const activeCommands = new Set<{
        readonly controller: AbortController;
        readonly execution: Promise<unknown>;
    }>();
    const peer = createExtensionRpcPeer({
        input: process.stdin,
        output: process.stdout,
        label: "extension child",
        requestIdPrefix: "e",
    });

    peer.register("activate", async (value) => {
        if (phase !== "idle") {
            throw new Error("Extension is already activated");
        }
        const params = parseActivateParams(value);
        if (params === undefined) {
            throw new ExtensionRpcHandlerError(
                "invalid_frame",
                "Invalid extension activation parameters",
            );
        }
        if (params.rpcVersion !== EXTENSION_RPC_VERSION) {
            throw new ExtensionRpcHandlerError(
                "protocol_mismatch",
                `Unsupported extension RPC version: ${params.rpcVersion}`,
            );
        }

        phase = "activating";
        activation = activate(params);
        try {
            await activation;
            phase = "active";
            return { handlers: declarations };
        } catch (error) {
            phase = "failed";
            throw error;
        }

        async function activate(params: ActivateParams): Promise<void> {
            const imported: unknown = await import(
                pathToFileURL(entrypointPath).href
            );
            const extension = parseExtensionModule(imported);
            if (extension === undefined) {
                throw new Error(
                    "Extension entrypoint must export an activate function",
                );
            }

            const api: VeraExtensionApi = Object.freeze({
                config: structuredClone(params.config),
                workspace: params.workspace,
                commands: Object.freeze({
                    register(spec: VeraExtensionCommandSpec): void {
                        registerCommand(spec, params.capabilities);
                    },
                }),
                onDispose(dispose: VeraExtensionDisposer): void {
                    if (phase !== "activating") {
                        throw new Error(
                            "Extension disposal must be registered during activation",
                        );
                    }
                    if (typeof dispose !== "function") {
                        throw new Error(
                            "Extension disposer must be a function",
                        );
                    }
                    disposers.push(dispose);
                },
            });

            await extension.activate(api);
        }
    });

    peer.register("invoke", async (value, context) => {
        if (phase !== "active") {
            throw new ExtensionRpcHandlerError(
                "disposed",
                "Extension is not accepting command invocations",
            );
        }
        const request = parseInvokeParams(value);
        if (request === undefined) {
            throw new ExtensionRpcHandlerError(
                "invalid_frame",
                "Invalid extension invocation parameters",
            );
        }
        const handler = commandHandlers.get(request.handlerId);
        if (handler === undefined) {
            throw new ExtensionRpcHandlerError(
                "unknown_handler",
                `Unknown extension handler: ${request.handlerId}`,
            );
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        context.signal.addEventListener("abort", abort, { once: true });
        const execution = Promise.resolve(handler({
            argumentsText: request.argumentsText,
            signal: controller.signal,
        }));
        const active = { controller, execution };
        activeCommands.add(active);
        try {
            const body = await execution;
            const parsed = parseExtensionCommandBody(body);
            if (parsed === undefined) {
                throw new Error("Extension command returned an invalid body");
            }
            return parsed;
        } finally {
            activeCommands.delete(active);
            context.signal.removeEventListener("abort", abort);
        }
    });

    peer.register("dispose", async () => {
        if (disposal !== undefined) {
            await disposal;
            return null;
        }
        if (phase === "disposed") {
            return null;
        }

        disposal = dispose();
        await disposal;
        return null;

        async function dispose(): Promise<void> {
            if (phase === "activating") {
                try {
                    await activation;
                } catch {
                    // Partial activation still owns its registered cleanup.
                }
            }
            phase = "disposing";
            for (const command of activeCommands) {
                command.controller.abort();
            }
            await Promise.allSettled(
                [...activeCommands].map((command) => command.execution),
            );
            const failures: string[] = [];
            for (const [index, dispose] of disposers.toReversed().entries()) {
                try {
                    await dispose();
                } catch (error) {
                    failures.push(
                        `disposer ${disposers.length - index}: ${errorMessage(error)}`,
                    );
                }
            }
            disposers.length = 0;
            phase = "disposed";
            if (failures.length > 0) {
                throw new Error(
                    `Extension cleanup failed: ${failures.join("; ")}`,
                );
            }
        }
    });

    return { peer };

    function registerCommand(
        spec: VeraExtensionCommandSpec,
        capabilities: readonly string[],
    ): void {
        if (phase !== "activating") {
            throw new Error(
                "Extension commands must be registered during activation",
            );
        }
        if (!capabilities.includes("commands.register")) {
            throw new ExtensionRpcHandlerError(
                "undeclared_capability",
                "Extension did not declare commands.register",
            );
        }
        if (typeof spec !== "object" || spec === null) {
            throw new Error("Invalid extension command registration");
        }
        const {
            name,
            description,
            usage,
            run,
        } = spec;
        if (
            typeof name !== "string"
            || !isExtensionCommandName(name)
            || typeof description !== "string"
            || description.trim().length === 0
            || typeof usage !== "string"
            || usage.trim().length === 0
            || typeof run !== "function"
        ) {
            throw new Error("Invalid extension command registration");
        }
        if (commandNames.has(name)) {
            throw new Error(
                `Duplicate extension command: ${name}`,
            );
        }
        const handlerId = `command:${declarations.length + 1}`;
        commandNames.add(name);
        commandHandlers.set(handlerId, run);
        declarations.push({
            handlerId,
            kind: "command",
            name,
            spec: {
                description: description.trim(),
                usage: usage.trim(),
            },
        });
    }
}

function parseInvokeParams(
    value: JsonValue,
): { readonly handlerId: string; readonly argumentsText: string } | undefined {
    if (
        !isPlainObject(value)
        || Object.keys(value).length !== 2
        || typeof value.handlerId !== "string"
        || value.handlerId.length === 0
        || typeof value.argumentsText !== "string"
    ) {
        return undefined;
    }
    return {
        handlerId: value.handlerId,
        argumentsText: value.argumentsText,
    };
}

function parseActivateParams(value: JsonValue): ActivateParams | undefined {
    if (
        !isPlainObject(value)
        || typeof value.rpcVersion !== "number"
        || typeof value.extensionId !== "string"
        || value.extensionId.length === 0
        || typeof value.extensionVersion !== "string"
        || value.extensionVersion.length === 0
        || !Array.isArray(value.capabilities)
        || !value.capabilities.every((item) => typeof item === "string")
        || !isJsonValue(value.config)
        || typeof value.workspace !== "string"
        || value.workspace.length === 0
    ) {
        return undefined;
    }
    return {
        rpcVersion: value.rpcVersion,
        extensionId: value.extensionId,
        extensionVersion: value.extensionVersion,
        capabilities: value.capabilities,
        config: value.config,
        workspace: value.workspace,
    };
}

function parseExtensionModule(value: unknown): VeraExtensionModule | undefined {
    if (
        typeof value !== "object"
        || value === null
        || !("activate" in value)
        || typeof value.activate !== "function"
    ) {
        return undefined;
    }
    return { activate: value.activate as VeraExtensionModule["activate"] };
}

function redirectConsoleToStderr(): void {
    const redirected = new Console({
        stdout: process.stderr,
        stderr: process.stderr,
    });
    Object.assign(globalThis.console, redirected);
}

function isPlainObject(
    value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
    ) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    return typeof value === "object"
        && value !== null
        && Object.values(value).every(isJsonValue);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
    const entrypointPath = process.argv[2];
    if (entrypointPath === undefined || entrypointPath.length === 0) {
        process.stderr.write("Missing extension entrypoint path\n");
        process.exit(2);
    }
    runExtensionChildRuntime(entrypointPath);
}
