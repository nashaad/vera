import type { VeraExtensionConfig } from "../config.ts";
import type {
    ExtensionCommandDescriptor,
    ExtensionCommandResult,
} from "./commands.ts";
import { RESERVED_EXTENSION_COMMAND_NAMES } from "./commands.ts";
import { loadExtensionManifest } from "./manifest.ts";
import {
    startUserExtension,
    type RunningUserExtension,
} from "./supervisor.ts";

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATE_GRACE_MS = 500;

export interface StartExtensionRegistryOptions {
    readonly extensions: readonly VeraExtensionConfig[];
    readonly activationTimeoutMs?: number;
    readonly handlerTimeoutMs?: number;
    readonly disposeTimeoutMs?: number;
    readonly terminateGraceMs?: number;
    readonly onDiagnostic?: (extensionId: string, message: string) => void;
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

interface LoadedRegistryExtension {
    readonly path: string;
    readonly running: RunningUserExtension;
}

export async function startExtensionRegistry(
    options: StartExtensionRegistryOptions,
): Promise<ExtensionRegistry> {
    const loaded: LoadedRegistryExtension[] = [];
    const owners = new Map<string, LoadedRegistryExtension>();
    const commands = new Map<string, {
        readonly owner: LoadedRegistryExtension;
        readonly descriptor: ExtensionCommandDescriptor;
    }>();
    let closing: Promise<void> | undefined;

    for (const configured of options.extensions) {
        if (!configured.enabled) {
            continue;
        }

        let running: RunningUserExtension | undefined;
        let entry: LoadedRegistryExtension | undefined;
        let entryFailed = false;
        let runtimeFailureReported = false;
        try {
            const manifest = loadExtensionManifest(configured.path);
            if (owners.has(manifest.manifest.id)) {
                throw new Error(
                    `Duplicate extension ID: ${manifest.manifest.id}`,
                );
            }
            running = await startUserExtension({
                loaded: manifest,
                config: configured.config,
                activationTimeoutMs: options.activationTimeoutMs
                    ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
                handlerTimeoutMs: options.handlerTimeoutMs
                    ?? DEFAULT_HANDLER_TIMEOUT_MS,
                disposeTimeoutMs: options.disposeTimeoutMs
                    ?? DEFAULT_DISPOSE_TIMEOUT_MS,
                terminateGraceMs: options.terminateGraceMs
                    ?? DEFAULT_TERMINATE_GRACE_MS,
                onDiagnostic: (diagnostic) => {
                    safelyReportDiagnostic(
                        options.onDiagnostic,
                        diagnostic.extensionId,
                        diagnostic.message,
                    );
                },
                onFailure: (failure) => {
                    entryFailed = true;
                    runtimeFailureReported = true;
                    if (entry !== undefined) {
                        removeCommands(entry);
                    }
                    safelyReportFailure(options.onFailure, {
                        path: configured.path,
                        extensionId: failure.extensionId,
                        message: failure.message,
                    });
                },
            });
            entry = {
                path: configured.path,
                running,
            };
            if (entryFailed) {
                throw new Error(
                    `Extension ${running.id} exited before registration completed`,
                );
            }
            for (const descriptor of running.commands) {
                if (RESERVED_EXTENSION_COMMAND_NAMES.includes(
                    descriptor.name as typeof RESERVED_EXTENSION_COMMAND_NAMES[number],
                )) {
                    throw new Error(
                        `Extension command /${descriptor.name} from ${running.id} collides with a bundled client command`,
                    );
                }
                const existing = commands.get(descriptor.name);
                if (existing !== undefined) {
                    throw new Error(
                        `Extension command /${descriptor.name} from ${running.id} collides with ${existing.owner.running.id}`,
                    );
                }
            }
            if (entryFailed) {
                throw new Error(
                    `Extension ${running.id} exited before registration completed`,
                );
            }
            loaded.push(entry);
            owners.set(running.id, entry);
            for (const descriptor of running.commands) {
                commands.set(descriptor.name, {
                    owner: entry,
                    descriptor,
                });
            }
        } catch (error) {
            let message = errorMessage(error);
            if (running !== undefined) {
                try {
                    await running.dispose();
                } catch (cleanupError) {
                    message += `; cleanup failed: ${errorMessage(cleanupError)}`;
                }
            }
            if (!runtimeFailureReported) {
                safelyReportFailure(options.onFailure, {
                    path: configured.path,
                    ...(running === undefined
                        ? {}
                        : { extensionId: running.id }),
                    message,
                });
            }
        }
    }

    return {
        commands(): readonly ExtensionCommandDescriptor[] {
            return [...commands.values()].map((entry) => entry.descriptor);
        },
        invokeCommand(
            name: string,
            argumentsText: string,
            workspace: string,
            signal?: AbortSignal,
        ): Promise<ExtensionCommandResult> {
            if (closing !== undefined) {
                return Promise.reject(
                    new Error("Extension registry is closing"),
                );
            }
            const command = commands.get(name);
            if (command === undefined) {
                return Promise.reject(
                    new Error(`Extension command /${name} is unavailable`),
                );
            }
            return command.owner.running.invokeCommand(
                name,
                argumentsText,
                workspace,
                { signal },
            );
        },
        close(): Promise<void> {
            closing ??= close();
            return closing;
        },
    };

    function removeCommands(extension: LoadedRegistryExtension): void {
        for (const [name, command] of commands) {
            if (command.owner === extension) {
                commands.delete(name);
            }
        }
    }

    async function close(): Promise<void> {
        const failures: string[] = [];
        commands.clear();
        for (const extension of loaded.toReversed()) {
            try {
                await extension.running.dispose();
            } catch (error) {
                failures.push(
                    `${extension.running.id}: ${errorMessage(error)}`,
                );
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

function safelyReportDiagnostic(
    report: StartExtensionRegistryOptions["onDiagnostic"],
    extensionId: string,
    message: string,
): void {
    try {
        report?.(extensionId, message);
    } catch {
        // Diagnostics cannot affect registry lifecycle.
    }
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
