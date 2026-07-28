import { pathToFileURL } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";
import type {
    ToolPresentation,
} from "../model/types.ts";
import type {
    VeraExtensionApi,
    VeraExtensionCommandHandler,
    VeraExtensionCommandSpec,
    VeraExtensionDisposer,
    VeraExtensionModule,
    VeraExtensionToolHandler,
    VeraExtensionToolSpec,
} from "../sdk/extensions.ts";
import type { RegisteredTool } from "../tools/types.ts";
import { isBuiltInToolName } from "../tools/execute.ts";
import { runExtensionOperation } from "./operation.ts";
import {
    EXTENSION_COMMAND_RESULT_VERSION,
    ExtensionCommandUnavailableError,
    isExtensionCommandName,
    InvalidExtensionCommandResultError,
    parseExtensionCommandBody,
    RESERVED_EXTENSION_COMMAND_NAMES,
    type ExtensionCommandDescriptor,
    type ExtensionCommandResult,
} from "./commands.ts";
import {
    createHostContributionSet,
    type HostContributionSet,
} from "./contribution-set.ts";
import {
    hasContributions,
    loadExtensionManifest,
    type LoadedExtensionManifest,
} from "./manifest.ts";

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
const MAX_EXTENSION_PRESENTATION_BYTES = 64 * 1024;
const MAX_EXTENSION_DIFF_LINES = 400;

export interface StartExtensionRegistryOptions {
    readonly extensions: readonly VeraExtensionConfig[];
    readonly activationTimeoutMs?: number;
    readonly handlerTimeoutMs?: number;
    readonly disposeTimeoutMs?: number;
    readonly onFailure?: (failure: ExtensionRegistryFailure) => void;
}

export interface ExtensionRegistryFailure {
    readonly path: string;
    readonly extensionId?: string;
    readonly message: string;
}

export interface ExtensionRegistry {
    commands(): readonly ExtensionCommandDescriptor[];
    tools(): readonly RegisteredTool[];
    contributions(): HostContributionSet;
    invokeCommand(
        name: string,
        argumentsText: string,
        workspace: string,
        signal?: AbortSignal,
    ): Promise<ExtensionCommandResult>;
    close(): Promise<void>;
}

interface RegisteredExtensionCommand {
    readonly descriptor: ExtensionCommandDescriptor;
    readonly run: VeraExtensionCommandHandler;
}

interface RegisteredExtensionTool {
    readonly tool: RegisteredTool;
    readonly run: VeraExtensionToolHandler;
}

interface LoadedRegistryExtension {
    readonly id: string;
    readonly path: string;
    readonly commands: readonly RegisteredExtensionCommand[];
    readonly tools: readonly RegisteredExtensionTool[];
    readonly disposers: readonly VeraExtensionDisposer[];
    readonly activeInvocations: Set<ActiveExtensionInvocation>;
    disposing: boolean;
}

interface ActiveExtensionInvocation {
    readonly controller: AbortController;
    readonly completion: Promise<void>;
}

interface RegisteredCommandOwner {
    readonly extension: LoadedRegistryExtension;
    readonly command: RegisteredExtensionCommand;
}

export async function startExtensionRegistry(
    options: StartExtensionRegistryOptions,
): Promise<ExtensionRegistry> {
    const activationTimeoutMs = options.activationTimeoutMs
        ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    const handlerTimeoutMs = options.handlerTimeoutMs
        ?? DEFAULT_HANDLER_TIMEOUT_MS;
    const disposeTimeoutMs = options.disposeTimeoutMs
        ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    const loaded: LoadedRegistryExtension[] = [];
    const owners = new Map<string, LoadedRegistryExtension>();
    const commands = new Map<string, RegisteredCommandOwner>();
    const tools = new Map<string, LoadedRegistryExtension>();
    const contributions = createHostContributionSet();
    let closing: Promise<void> | undefined;

    for (const configured of options.extensions) {
        if (!configured.enabled) {
            continue;
        }

        let extension: LoadedRegistryExtension | undefined;
        let extensionId: string | undefined;
        let admitted = false;
        try {
            const manifest = loadExtensionManifest(configured.path);
            const servesHost = manifest.manifest.capabilities.some(
                (capability) => !capability.startsWith("client."),
            ) || hasContributions(manifest.manifest);
            if (!servesHost) {
                continue;
            }
            extensionId = manifest.manifest.id;
            if (owners.has(manifest.manifest.id)) {
                throw new Error(
                    `Duplicate extension ID: ${manifest.manifest.id}`,
                );
            }
            // Contributions are admitted before the entrypoint is imported, so a
            // rejected contribution runs no extension code.
            contributions.admit(
                manifest.manifest.id,
                manifest.manifest.contributes,
            );
            admitted = true;
            extension = await activateExtension(
                manifest,
                configured.config,
                activationTimeoutMs,
                handlerTimeoutMs,
                disposeTimeoutMs,
            );
            validateCommandOwnership(extension, commands);
            validateToolOwnership(extension, tools);
            loaded.push(extension);
            owners.set(extension.id, extension);
            for (const command of extension.commands) {
                commands.set(command.descriptor.name, {
                    extension,
                    command,
                });
            }
            for (const registered of extension.tools) {
                tools.set(registered.tool.definition.name, extension);
            }
        } catch (error) {
            let message = errorMessage(error);
            if (admitted && extensionId !== undefined) {
                contributions.withdraw(extensionId);
            }
            if (extension !== undefined) {
                try {
                    await disposeExtension(extension, disposeTimeoutMs);
                } catch (cleanupError) {
                    message += `; cleanup failed: ${errorMessage(cleanupError)}`;
                }
            }
            safelyReportFailure(options.onFailure, {
                path: configured.path,
                ...(extensionId === undefined
                    ? {}
                    : { extensionId }),
                message,
            });
        }
    }

    contributions.freeze();

    return {
        contributions(): HostContributionSet {
            return contributions;
        },
        commands(): readonly ExtensionCommandDescriptor[] {
            return [...commands.values()].map(
                (entry) => entry.command.descriptor,
            );
        },
        tools(): readonly RegisteredTool[] {
            return loaded.flatMap((extension) =>
                extension.tools.map((registered) => registered.tool)
            );
        },
        async invokeCommand(
            name: string,
            argumentsText: string,
            workspace: string,
            signal?: AbortSignal,
        ): Promise<ExtensionCommandResult> {
            if (closing !== undefined) {
                throw new Error("Extension registry is closing");
            }
            const owner = commands.get(name);
            if (owner === undefined || owner.extension.disposing) {
                throw new ExtensionCommandUnavailableError(
                    `Extension command /${name} is unavailable`,
                );
            }

            const controller = new AbortController();
            const abort = (): void => controller.abort();
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) {
                abort();
            }
            let active: ActiveExtensionInvocation | undefined;
            try {
                const body = await runExtensionOperation(
                    (operationSignal) => owner.command.run({
                        argumentsText,
                        workspace,
                        signal: operationSignal,
                    }),
                    {
                        timeoutMs: handlerTimeoutMs,
                        timeoutMessage:
                            `Extension ${owner.extension.id}/${name} timed out after ${handlerTimeoutMs}ms`,
                        abortMessage:
                            `Extension ${owner.extension.id}/${name} was cancelled`,
                        signal: controller.signal,
                        onExecutionStart(execution) {
                            active = {
                                controller,
                                completion: execution.then(
                                    () => undefined,
                                    () => undefined,
                                ),
                            };
                            owner.extension.activeInvocations.add(active);
                        },
                    },
                );
                const parsed = parseExtensionCommandBody(body);
                if (parsed === undefined) {
                    throw new InvalidExtensionCommandResultError(
                        `Extension ${owner.extension.id}/${name} returned an invalid result`,
                    );
                }
                return {
                    version: EXTENSION_COMMAND_RESULT_VERSION,
                    source: `${owner.extension.id}/${name}`,
                    body: parsed,
                };
            } finally {
                if (active !== undefined) {
                    void active.completion.finally(() => {
                        owner.extension.activeInvocations.delete(active!);
                    });
                }
                signal?.removeEventListener("abort", abort);
            }
        },
        close(): Promise<void> {
            closing ??= close();
            return closing;
        },
    };

    async function close(): Promise<void> {
        commands.clear();
        tools.clear();
        const failures: string[] = [];
        for (const extension of loaded.toReversed()) {
            contributions.withdraw(extension.id);
            try {
                await disposeExtension(extension, disposeTimeoutMs);
            } catch (error) {
                failures.push(`${extension.id}: ${errorMessage(error)}`);
            }
        }
        loaded.length = 0;
        owners.clear();
        if (failures.length > 0) {
            throw new Error(
                `Extension registry cleanup failed: ${failures.join("; ")}`,
            );
        }
    }
}

async function activateExtension(
    loaded: LoadedExtensionManifest,
    config: VeraExtensionConfig["config"],
    activationTimeoutMs: number,
    handlerTimeoutMs: number,
    disposeTimeoutMs: number,
): Promise<LoadedRegistryExtension> {
    const commands: RegisteredExtensionCommand[] = [];
    const commandNames = new Set<string>();
    const tools: RegisteredExtensionTool[] = [];
    const toolNames = new Set<string>();
    const disposers: VeraExtensionDisposer[] = [];
    const activeInvocations = new Set<ActiveExtensionInvocation>();
    let phase: "activating" | "active" | "failed" = "activating";
    let activationCompletion: Promise<unknown> | undefined;
    let activationSettled = false;
    const api: VeraExtensionApi = Object.freeze({
        config: structuredClone(config),
        commands: Object.freeze({
            register(spec: VeraExtensionCommandSpec): void {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension commands must be registered during activation",
                    );
                }
                registerCommand(
                    loaded,
                    spec,
                    commands,
                    commandNames,
                );
            },
        }),
        tools: Object.freeze({
            register(spec: VeraExtensionToolSpec): void {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension tools must be registered during activation",
                    );
                }
                registerTool(
                    loaded,
                    spec,
                    tools,
                    toolNames,
                    handlerTimeoutMs,
                    activeInvocations,
                );
            },
        }),
        onDispose(dispose: VeraExtensionDisposer): void {
            if (phase !== "activating") {
                throw new Error(
                    "Extension disposal must be registered during activation",
                );
            }
            if (typeof dispose !== "function") {
                throw new Error("Extension disposer must be a function");
            }
            disposers.push(dispose);
        },
    });

    try {
        await runExtensionOperation(
            async () => {
                try {
                    const imported: unknown = await import(
                        pathToFileURL(loaded.entrypointPath).href
                    );
                    const extension = parseExtensionModule(imported);
                    if (extension === undefined) {
                        throw new Error(
                            "Extension entrypoint must export an activate function",
                        );
                    }
                    await extension.activate(api);
                } finally {
                    activationSettled = true;
                }
            },
            {
                timeoutMs: activationTimeoutMs,
                timeoutMessage:
                    `Extension ${loaded.manifest.id} activation timed out after ${activationTimeoutMs}ms`,
                abortMessage:
                    `Extension ${loaded.manifest.id} activation was cancelled`,
                onExecutionStart(execution) {
                    activationCompletion = execution;
                },
            },
        );
        phase = "active";
        return {
            id: loaded.manifest.id,
            path: loaded.directory,
            commands,
            tools,
            disposers,
            activeInvocations,
            disposing: false,
        };
    } catch (error) {
        phase = "failed";
        const cleanupFailures = activationSettled
            ? await runDisposers(disposers, disposeTimeoutMs)
            : [];
        if (!activationSettled) {
            void activationCompletion?.finally(async () => {
                await runDisposers(disposers, disposeTimeoutMs);
            }).catch(() => undefined);
        }
        const suffix = cleanupFailures.length === 0
            ? ""
            : `; cleanup failed: ${cleanupFailures.join("; ")}`;
        throw new Error(
            `Extension ${loaded.manifest.id} failed to load: ${errorMessage(error)}${suffix}`,
        );
    }
}

function registerTool(
    loaded: LoadedExtensionManifest,
    spec: VeraExtensionToolSpec,
    tools: RegisteredExtensionTool[],
    toolNames: Set<string>,
    handlerTimeoutMs: number,
    activeInvocations: Set<ActiveExtensionInvocation>,
): void {
    if (!loaded.manifest.capabilities.includes("tools.register")) {
        throw new Error("Extension did not declare tools.register");
    }
    if (typeof spec !== "object" || spec === null) {
        throw new Error("Invalid extension tool registration");
    }
    const {
        name,
        description,
        inputSchema,
        parallel,
        permissionOperation,
        permissionInputs,
        run,
    } = spec;
    if (
        typeof name !== "string"
        || !/^[a-z][a-z0-9_]*$/.test(name)
        || typeof description !== "string"
        || description.trim().length === 0
        || !isPlainObject(inputSchema)
        || inputSchema.type !== "object"
        || (parallel !== undefined && typeof parallel !== "boolean")
        || (permissionOperation !== undefined
            && (
                typeof permissionOperation !== "string"
                || permissionOperation.trim().length === 0
            ))
        || !validPermissionInputs(permissionInputs)
        || typeof run !== "function"
    ) {
        throw new Error("Invalid extension tool registration");
    }
    if (toolNames.has(name)) {
        throw new Error(`Duplicate extension tool: ${name}`);
    }
    if (isBuiltInToolName(name)) {
        throw new Error(`Extension tool ${name} collides with a built-in tool`);
    }
    const properties = isPlainObject(inputSchema.properties)
        ? inputSchema.properties
        : undefined;
    for (const permissionInput of permissionInputs ?? []) {
        const property = properties?.[permissionInput.field];
        if (!isPlainObject(property) || property.type !== "string") {
            throw new Error(
                `Extension tool ${name} declares permission input `
                    + `"${permissionInput.field}" that is not a string field`,
            );
        }
    }
    const handler = run;
    const tool: RegisteredTool = {
        definition: {
            name,
            description: description.trim(),
            inputSchema: structuredClone(inputSchema),
        },
        ...(parallel === undefined ? {} : { parallel }),
        ...(permissionOperation === undefined
            ? {}
            : { permissionOperation: permissionOperation.trim() }),
        ...(permissionInputs === undefined
            ? {}
            : { permissionInputs: structuredClone(permissionInputs) }),
        async execute(input, context, signal) {
            const controller = new AbortController();
            const abort = (): void => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                abort();
            }
            let active: ActiveExtensionInvocation | undefined;
            let result: unknown;
            try {
                result = await runExtensionOperation(
                    (operationSignal) => handler({
                        input: structuredClone(input),
                        workspace: context.workspace,
                        signal: operationSignal,
                    }),
                    {
                        timeoutMs: handlerTimeoutMs,
                        timeoutMessage:
                            `Extension ${loaded.manifest.id}/${name} timed out after ${handlerTimeoutMs}ms`,
                        abortMessage:
                            `Extension ${loaded.manifest.id}/${name} was cancelled`,
                        signal: controller.signal,
                        onExecutionStart(execution) {
                            active = {
                                controller,
                                completion: execution.then(
                                    () => undefined,
                                    () => undefined,
                                ),
                            };
                            activeInvocations.add(active);
                        },
                    },
                );
            } finally {
                if (active !== undefined) {
                    void active.completion.finally(() => {
                        activeInvocations.delete(active!);
                    });
                }
                signal.removeEventListener("abort", abort);
            }
            if (
                !isPlainObject(result)
                || typeof result.output !== "string"
                || (result.isError !== undefined
                    && typeof result.isError !== "boolean")
            ) {
                throw new Error(
                    `Extension ${loaded.manifest.id}/${name} returned an invalid result`,
                );
            }
            const presentation = result.presentation === undefined
                ? undefined
                : parseToolPresentation(result.presentation);
            if (
                result.presentation !== undefined
                && presentation === undefined
            ) {
                throw new Error(
                    `Extension ${loaded.manifest.id}/${name} returned an invalid result`,
                );
            }
            return {
                kind: "output",
                output: result.output,
                isError: result.isError ?? false,
                ...(presentation === undefined
                    ? {}
                    : { presentation }),
            };
        },
    };
    toolNames.add(name);
    tools.push({ tool, run });
}

function parseToolPresentation(value: unknown): ToolPresentation | undefined {
    if (!isPlainObject(value)) return undefined;
    if (
        value.kind === "unified_diff"
        && hasExactKeys(value, ["kind", "path", "patch"])
        && typeof value.path === "string"
        && value.path.length > 0
        && typeof value.patch === "string"
        && value.patch.length > 0
        && Buffer.byteLength(value.patch) <= MAX_EXTENSION_PRESENTATION_BYTES
        && value.patch.split("\n").length <= MAX_EXTENSION_DIFF_LINES
    ) {
        return {
            kind: "unified_diff",
            path: value.path,
            patch: value.patch,
        };
    }
    if (
        value.kind === "tool_notice"
        && hasExactKeys(value, ["kind", "text"])
        && typeof value.text === "string"
        && value.text.trim().length > 0
        && Buffer.byteLength(value.text) <= MAX_EXTENSION_PRESENTATION_BYTES
    ) {
        return { kind: "tool_notice", text: value.text };
    }
    return undefined;
}

function hasExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function validPermissionInputs(value: unknown): boolean {
    return value === undefined
        || (
            Array.isArray(value)
            && value.every((entry) =>
                isPlainObject(entry)
                && typeof entry.field === "string"
                && entry.field.length > 0
                && (entry.kind === "path" || entry.kind === "url")
                && (
                    entry.verb === "read"
                    || entry.verb === "write"
                    || entry.verb === "delete"
                )
            )
        );
}

function isPlainObject(
    value: unknown,
): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function registerCommand(
    loaded: LoadedExtensionManifest,
    spec: VeraExtensionCommandSpec,
    commands: RegisteredExtensionCommand[],
    commandNames: Set<string>,
): void {
    if (!loaded.manifest.capabilities.includes("commands.register")) {
        throw new Error(
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
        throw new Error(`Duplicate extension command: ${name}`);
    }
    commandNames.add(name);
    commands.push({
        descriptor: {
            name,
            description: description.trim(),
            usage: usage.trim(),
            source: loaded.manifest.id,
        },
        run,
    });
}

function validateCommandOwnership(
    extension: LoadedRegistryExtension,
    commands: ReadonlyMap<string, RegisteredCommandOwner>,
): void {
    for (const command of extension.commands) {
        const name = command.descriptor.name;
        if (RESERVED_EXTENSION_COMMAND_NAMES.includes(
            name as typeof RESERVED_EXTENSION_COMMAND_NAMES[number],
        )) {
            throw new Error(
                `Extension command /${name} from ${extension.id} collides with a built-in client command`,
            );
        }
        const existing = commands.get(name);
        if (existing !== undefined) {
            throw new Error(
                `Extension command /${name} from ${extension.id} collides with ${existing.extension.id}`,
            );
        }
    }
}

function validateToolOwnership(
    extension: LoadedRegistryExtension,
    tools: ReadonlyMap<string, LoadedRegistryExtension>,
): void {
    for (const registered of extension.tools) {
        const name = registered.tool.definition.name;
        const existing = tools.get(name);
        if (existing !== undefined) {
            throw new Error(
                `Extension tool ${name} from ${extension.id} collides with ${existing.id}`,
            );
        }
    }
}

async function disposeExtension(
    extension: LoadedRegistryExtension,
    timeoutMs: number,
): Promise<void> {
    if (extension.disposing) {
        return;
    }
    extension.disposing = true;
    for (const invocation of extension.activeInvocations) {
        invocation.controller.abort();
    }
    const failures: string[] = [];
    try {
        await runExtensionOperation(
            () => Promise.allSettled(
                [...extension.activeInvocations].map(
                    (invocation) => invocation.completion,
                ),
            ),
            {
                timeoutMs,
                timeoutMessage:
                    `Extension ${extension.id} active handlers did not stop after ${timeoutMs}ms`,
                abortMessage:
                    `Extension ${extension.id} active handler wait was cancelled`,
            },
        );
    } catch (error) {
        failures.push(errorMessage(error));
    }
    if (failures.length === 0) {
        failures.push(...await runDisposers(extension.disposers, timeoutMs));
    }
    if (failures.length > 0) {
        throw new Error(
            `Extension ${extension.id} cleanup failed: ${failures.join("; ")}`,
        );
    }
}

async function runDisposers(
    disposers: readonly VeraExtensionDisposer[],
    timeoutMs: number,
): Promise<string[]> {
    const failures: string[] = [];
    for (const [index, dispose] of disposers.toReversed().entries()) {
        try {
            await runExtensionOperation(
                () => dispose(),
                {
                    timeoutMs,
                    timeoutMessage:
                        `Extension disposer timed out after ${timeoutMs}ms`,
                    abortMessage: "Extension disposer was cancelled",
                },
            );
        } catch (error) {
            failures.push(
                `disposer ${disposers.length - index}: ${errorMessage(error)}`,
            );
        }
    }
    return failures;
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

function safelyReportFailure(
    report: StartExtensionRegistryOptions["onFailure"],
    failure: ExtensionRegistryFailure,
): void {
    try {
        report?.(failure);
    } catch {
        // Optional reporting cannot affect registry lifecycle.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
