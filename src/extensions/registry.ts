import { pathToFileURL } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";
import type {
    VeraExtensionApi,
    VeraExtensionCommandHandler,
    VeraExtensionCommandSpec,
    VeraExtensionDisposer,
    VeraExtensionModule,
} from "../sdk/extensions.ts";
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
    loadExtensionManifest,
    type LoadedExtensionManifest,
} from "./manifest.ts";

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

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

interface LoadedRegistryExtension {
    readonly id: string;
    readonly path: string;
    readonly commands: readonly RegisteredExtensionCommand[];
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
    let closing: Promise<void> | undefined;

    for (const configured of options.extensions) {
        if (!configured.enabled) {
            continue;
        }

        let extension: LoadedRegistryExtension | undefined;
        let extensionId: string | undefined;
        try {
            const manifest = loadExtensionManifest(configured.path);
            if (!manifest.manifest.capabilities.some((capability) =>
                !capability.startsWith("client.")
            )) {
                continue;
            }
            extensionId = manifest.manifest.id;
            if (owners.has(manifest.manifest.id)) {
                throw new Error(
                    `Duplicate extension ID: ${manifest.manifest.id}`,
                );
            }
            extension = await activateExtension(
                manifest,
                configured.config,
                activationTimeoutMs,
                disposeTimeoutMs,
            );
            validateCommandOwnership(extension, commands);
            loaded.push(extension);
            owners.set(extension.id, extension);
            for (const command of extension.commands) {
                commands.set(command.descriptor.name, {
                    extension,
                    command,
                });
            }
        } catch (error) {
            let message = errorMessage(error);
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

    return {
        commands(): readonly ExtensionCommandDescriptor[] {
            return [...commands.values()].map(
                (entry) => entry.command.descriptor,
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
        const failures: string[] = [];
        for (const extension of loaded.toReversed()) {
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
    disposeTimeoutMs: number,
): Promise<LoadedRegistryExtension> {
    const commands: RegisteredExtensionCommand[] = [];
    const commandNames = new Set<string>();
    const disposers: VeraExtensionDisposer[] = [];
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
            disposers,
            activeInvocations: new Set(),
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
