import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

import { inferReasoningSelection } from "../model/reasoning-effort.ts";
import type { JsonValue } from "../sdk/hooks.ts";
import type {
    VeraClientAvailableModel,
    VeraClientExtensionApi,
    VeraClientExtensionCommandHandler,
    VeraClientExtensionCommandSpec,
    VeraClientExtensionKeybindingHandler,
    VeraClientExtensionKeybindingSpec,
    VeraClientExtensionModule,
    VeraClientExtensionStatusLineSpec,
    VeraClientMessageDecision,
    VeraClientMessageInterceptor,
    VeraClientStatusLineRenderer,
    VeraClientModelSettingsListener,
    VeraClientModelSettingsPatch,
    VeraClientModelSettingsSnapshot,
    VeraClientModelSettingsUpdateResult,
    VeraClientPickerRequest,
    VeraClientPickerResult,
    VeraClientModelAvailability,
    VeraClientReasoningLevel,
    VeraExtensionDisposer,
} from "../sdk/extensions.ts";
import {
    EXTENSION_COMMAND_RESULT_VERSION,
    isExtensionCommandName,
    parseExtensionCommandBody,
    type ExtensionCommandBody,
    type ExtensionCommandResult,
} from "./commands.ts";
import { loadExtensionManifest } from "./manifest.ts";
import { runExtensionOperation } from "./operation.ts";
import {
    parseStatusLineSegments,
    type StatusLineSegment,
    type StatusLineSnapshot,
} from "./status-line.ts";

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

const CLIENT_COMMAND_CAPABILITY = "client.commands.register";
const CLIENT_KEYBINDING_CAPABILITY = "client.keybindings.register";
const CLIENT_PREFERENCES_CAPABILITY = "client.preferences";
const CLIENT_MODEL_SETTINGS_CAPABILITY = "client.model_settings";
const CLIENT_PICKER_CAPABILITY = "client.ui.picker";
const CLIENT_NOTICE_CAPABILITY = "client.ui.notice";
const CLIENT_STATUS_LINE_CAPABILITY = "client.status_line";
const CLIENT_MESSAGE_INTERCEPT_CAPABILITY = "client.messages.intercept";

const DEFAULT_STATUS_LINE_BUDGET_MS = 50;
/**
 * A renderer that throws, stalls, or answers with garbage is taken off the
 * status line after this many strikes and the client's own rendering stands
 * in for good. Retrying forever would spend part of every repaint on an
 * extension that has already shown it cannot answer.
 */
const STATUS_LINE_FAILURE_LIMIT = 3;

export interface ClientExtensionConfig {
    readonly path: string;
    readonly enabled: boolean;
    readonly config: JsonValue;
}

export interface ClientExtensionCommandDescriptor {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly source: string;
    readonly palette?: {
        readonly label: string;
        readonly description?: string;
        readonly group?: "Session" | "Settings" | "Extensions";
        readonly keyHint?: string;
    };
}

export interface ClientExtensionKeybindingDescriptor {
    readonly id: string;
    readonly description: string;
    readonly keys: readonly string[];
    readonly source: string;
}

export interface ClientExtensionRegistryFailure {
    readonly path: string;
    readonly extensionId?: string;
    readonly message: string;
}

export interface ClientExtensionPreferencesAdapter {
    get(namespace: string, key: string): Promise<JsonValue | undefined>;
    set(namespace: string, key: string, value: JsonValue): Promise<void>;
    delete(namespace: string, key: string): Promise<void>;
}

export interface ClientExtensionModelSettingsAdapter {
    current(): VeraClientModelSettingsSnapshot | undefined;
    update(
        patch: VeraClientModelSettingsPatch,
        signal: AbortSignal,
    ): Promise<VeraClientModelSettingsUpdateResult>;
    subscribe(
        listener: VeraClientModelSettingsListener,
    ): VeraExtensionDisposer;
}

export interface ClientExtensionPickerAdapter {
    request(
        extensionId: string,
        request: VeraClientPickerRequest,
        signal: AbortSignal,
    ): Promise<VeraClientPickerResult>;
}

export interface ClientExtensionNoticeAdapter {
    post(extensionId: string, text: string): void;
}

export interface StartClientExtensionRegistryOptions {
    readonly extensions: readonly ClientExtensionConfig[];
    readonly preferences: ClientExtensionPreferencesAdapter;
    readonly modelSettings: ClientExtensionModelSettingsAdapter;
    readonly picker: ClientExtensionPickerAdapter;
    readonly notice: ClientExtensionNoticeAdapter;
    readonly reservedCommandNames?: readonly string[];
    readonly reservedKeybindingKeys?: readonly string[];
    readonly activationTimeoutMs?: number;
    readonly handlerTimeoutMs?: number;
    readonly disposeTimeoutMs?: number;
    /** How long one status line render may take before it counts as a strike. */
    readonly statusLineBudgetMs?: number;
    readonly onFailure?: (failure: ClientExtensionRegistryFailure) => void;
}

export interface ClientExtensionRegistry {
    commands(): readonly ClientExtensionCommandDescriptor[];
    keybindings(): readonly ClientExtensionKeybindingDescriptor[];
    invokeCommand(
        name: string,
        argumentsText: string,
        workspace: string,
        signal?: AbortSignal,
    ): Promise<ExtensionCommandResult | undefined>;
    invokeKeybinding(
        id: string,
        workspace: string,
        signal?: AbortSignal,
    ): Promise<void>;
    /**
     * Whether any loaded extension intercepts messages. Lets a client skip the
     * async hop on every submit when nothing is listening.
     */
    hasMessageInterceptors(): boolean;
    /**
     * Offer a submitted message to each interceptor in load order and return
     * the first decision that is not `pass`. An interceptor that fails is
     * treated as `pass`, so a broken extension cannot stop the user talking to
     * the agent.
     */
    interceptMessage(
        message: OutgoingClientMessage,
        signal?: AbortSignal,
    ): Promise<VeraClientMessageDecision>;
    /** The extension that owns the status line, absent while nobody does. */
    statusLineOwner(): string | undefined;
    /**
     * Synchronous by contract: this is called inside a repaint, so it never
     * awaits and never throws. Undefined means the client renders the status
     * line itself, which is also what a failing renderer resolves to.
     */
    renderStatusLine(
        snapshot: StatusLineSnapshot,
    ): readonly StatusLineSegment[] | undefined;
    close(): Promise<void>;
}

export interface OutgoingClientMessage {
    readonly text: string;
    readonly workspace: string;
    readonly imageCount: number;
}

interface RegisteredCommand {
    readonly descriptor: ClientExtensionCommandDescriptor;
    readonly run: VeraClientExtensionCommandHandler;
    readonly interactive: boolean;
}

interface RegisteredKeybinding {
    readonly descriptor: ClientExtensionKeybindingDescriptor;
    readonly run: VeraClientExtensionKeybindingHandler;
}

interface ActiveInvocation {
    readonly controller: AbortController;
    readonly completion: Promise<void>;
}

interface LoadedClientExtension {
    readonly id: string;
    readonly path: string;
    readonly commands: readonly RegisteredCommand[];
    readonly keybindings: readonly RegisteredKeybinding[];
    readonly statusLine: VeraClientStatusLineRenderer | undefined;
    readonly messageInterceptor: VeraClientMessageInterceptor | undefined;
    readonly disposers: readonly VeraExtensionDisposer[];
    readonly activeInvocations: Set<ActiveInvocation>;
    readonly invocationSignal: AsyncLocalStorage<AbortSignal>;
    readonly markUnavailable: () => void;
    disposing: boolean;
}

interface CommandOwner {
    readonly extension: LoadedClientExtension;
    readonly command: RegisteredCommand;
}

interface KeybindingOwner {
    readonly extension: LoadedClientExtension;
    readonly keybinding: RegisteredKeybinding;
}

interface StatusLineOwner {
    readonly extension: LoadedClientExtension;
    readonly render: VeraClientStatusLineRenderer;
    failures: number;
}

export async function startClientExtensionRegistry(
    options: StartClientExtensionRegistryOptions,
): Promise<ClientExtensionRegistry> {
    const activationTimeoutMs = options.activationTimeoutMs
        ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    const handlerTimeoutMs = options.handlerTimeoutMs
        ?? DEFAULT_HANDLER_TIMEOUT_MS;
    const disposeTimeoutMs = options.disposeTimeoutMs
        ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    const reservedCommands = new Set(options.reservedCommandNames ?? []);
    const reservedKeybindings = new Set(options.reservedKeybindingKeys ?? []);
    const loaded: LoadedClientExtension[] = [];
    const extensionIds = new Set<string>();
    const commands = new Map<string, CommandOwner>();
    const keybindings = new Map<string, KeybindingOwner>();
    const statusLineBudgetMs = options.statusLineBudgetMs
        ?? DEFAULT_STATUS_LINE_BUDGET_MS;
    let statusLine: StatusLineOwner | undefined;
    let closing: Promise<void> | undefined;

    for (const configured of options.extensions) {
        if (!configured.enabled) {
            continue;
        }

        let extension: LoadedClientExtension | undefined;
        let extensionId: string | undefined;
        try {
            const manifest = loadExtensionManifest(configured.path);
            if (!manifest.manifest.capabilities.some((capability) =>
                capability.startsWith("client.")
            )) {
                continue;
            }
            extensionId = manifest.manifest.id;
            if (extensionIds.has(extensionId)) {
                throw new Error(`Duplicate extension ID: ${extensionId}`);
            }
            extension = await activateClientExtension({
                id: extensionId,
                path: configured.path,
                entrypointPath: manifest.entrypointPath,
                capabilities: manifest.manifest.capabilities,
                config: configured.config,
                preferences: options.preferences,
                modelSettings: options.modelSettings,
                picker: options.picker,
                notice: options.notice,
                activationTimeoutMs,
            });
            validateOwnership(
                extension,
                commands,
                keybindings,
                statusLine,
                reservedCommands,
                reservedKeybindings,
            );
            loaded.push(extension);
            if (extension.statusLine !== undefined) {
                statusLine = {
                    extension,
                    render: extension.statusLine,
                    failures: 0,
                };
            }
            extensionIds.add(extension.id);
            for (const command of extension.commands) {
                commands.set(command.descriptor.name, { extension, command });
            }
            for (const keybinding of extension.keybindings) {
                keybindings.set(keybinding.descriptor.id, {
                    extension,
                    keybinding,
                });
            }
        } catch (error) {
            let message = errorMessage(error);
            if (extension !== undefined) {
                try {
                    await disposeClientExtension(extension, disposeTimeoutMs);
                } catch (cleanupError) {
                    message += `; cleanup failed: ${errorMessage(cleanupError)}`;
                }
            }
            safelyReportFailure(options.onFailure, {
                path: configured.path,
                ...(extensionId === undefined ? {} : { extensionId }),
                message,
            });
        }
    }

    return {
        commands(): readonly ClientExtensionCommandDescriptor[] {
            return [...commands.values()].map(
                ({ command }) => command.descriptor,
            );
        },
        keybindings(): readonly ClientExtensionKeybindingDescriptor[] {
            return [...keybindings.values()].map(
                ({ keybinding }) => keybinding.descriptor,
            );
        },
        async invokeCommand(
            name,
            argumentsText,
            workspace,
            signal,
        ): Promise<ExtensionCommandResult | undefined> {
            if (closing !== undefined) {
                throw new Error("Client extension registry is closing");
            }
            const owner = commands.get(name);
            if (owner === undefined || owner.extension.disposing) {
                throw new Error(`Client extension command /${name} is unavailable`);
            }
            const body = await invokeTracked(
                owner.extension,
                (operationSignal) => owner.command.run({
                    argumentsText,
                    workspace,
                    signal: operationSignal,
                }),
                owner.command.interactive ? undefined : handlerTimeoutMs,
                `Client extension ${owner.extension.id}/${name}`,
                signal,
            );
            if (body === undefined) {
                return undefined;
            }
            const parsed = parseExtensionCommandBody(body);
            if (parsed === undefined) {
                throw new Error(
                    `Client extension ${owner.extension.id}/${name} returned an invalid result`,
                );
            }
            return {
                version: EXTENSION_COMMAND_RESULT_VERSION,
                source: `${owner.extension.id}/${name}`,
                body: parsed,
            };
        },
        async invokeKeybinding(id, workspace, signal): Promise<void> {
            if (closing !== undefined) {
                throw new Error("Client extension registry is closing");
            }
            const owner = keybindings.get(id);
            if (owner === undefined || owner.extension.disposing) {
                throw new Error(`Client extension keybinding ${id} is unavailable`);
            }
            await invokeTracked(
                owner.extension,
                (operationSignal) => owner.keybinding.run({
                    workspace,
                    signal: operationSignal,
                }),
                handlerTimeoutMs,
                `Client extension ${owner.extension.id}/${id}`,
                signal,
            );
        },
        hasMessageInterceptors(): boolean {
            return closing === undefined
                && loaded.some((extension) =>
                    extension.messageInterceptor !== undefined
                    && !extension.disposing
                );
        },
        async interceptMessage(
            message: OutgoingClientMessage,
            signal?: AbortSignal,
        ): Promise<VeraClientMessageDecision> {
            if (closing !== undefined) {
                return { kind: "pass" };
            }
            for (const extension of loaded) {
                const intercept = extension.messageInterceptor;
                if (intercept === undefined || extension.disposing) {
                    continue;
                }
                let returned: unknown;
                try {
                    returned = await invokeTracked(
                        extension,
                        (operationSignal) => intercept(
                            { ...message },
                            operationSignal,
                        ),
                        handlerTimeoutMs,
                        `Client extension ${extension.id} message interceptor`,
                        signal,
                    );
                } catch (error) {
                    safelyReportFailure(options.onFailure, {
                        path: extension.path,
                        extensionId: extension.id,
                        message: `message interceptor failed: ${errorMessage(error)}`,
                    });
                    continue;
                }
                const decision = parseMessageDecision(returned);
                if (decision === undefined) {
                    safelyReportFailure(options.onFailure, {
                        path: extension.path,
                        extensionId: extension.id,
                        message: "message interceptor returned an invalid decision",
                    });
                    continue;
                }
                if (decision.kind !== "pass") {
                    return decision;
                }
            }
            return { kind: "pass" };
        },
        statusLineOwner(): string | undefined {
            return statusLine?.extension.id;
        },
        renderStatusLine(
            snapshot: StatusLineSnapshot,
        ): readonly StatusLineSegment[] | undefined {
            const owner = statusLine;
            if (
                owner === undefined
                || closing !== undefined
                || owner.extension.disposing
            ) {
                return undefined;
            }
            const started = performance.now();
            let returned: unknown;
            try {
                returned = owner.render(structuredClone(snapshot));
            } catch (error) {
                return failStatusLine(owner, errorMessage(error));
            }
            const elapsed = performance.now() - started;
            const segments = parseStatusLineSegments(returned);
            if (segments === undefined) {
                return failStatusLine(
                    owner,
                    "status line renderer returned an invalid result",
                );
            }
            if (elapsed > statusLineBudgetMs) {
                return failStatusLine(
                    owner,
                    `status line render took ${Math.round(elapsed)}ms,`
                        + ` over the ${statusLineBudgetMs}ms budget`,
                );
            }
            owner.failures = 0;
            return segments;
        },
        close(): Promise<void> {
            closing ??= close();
            return closing;
        },
    };

    /** Never rethrows: a repaint cannot be the place an extension fault lands. */
    function failStatusLine(owner: StatusLineOwner, message: string): undefined {
        owner.failures += 1;
        const retired = owner.failures >= STATUS_LINE_FAILURE_LIMIT;
        if (retired) {
            statusLine = undefined;
        }
        safelyReportFailure(options.onFailure, {
            path: owner.extension.path,
            extensionId: owner.extension.id,
            message: retired
                ? `${message}; status line handed back to the client`
                : message,
        });
        return undefined;
    }

    async function close(): Promise<void> {
        commands.clear();
        keybindings.clear();
        statusLine = undefined;
        const failures: string[] = [];
        for (const extension of loaded.toReversed()) {
            try {
                await disposeClientExtension(extension, disposeTimeoutMs);
            } catch (error) {
                failures.push(`${extension.id}: ${errorMessage(error)}`);
            }
        }
        loaded.length = 0;
        extensionIds.clear();
        if (failures.length > 0) {
            throw new Error(
                `Client extension registry cleanup failed: ${failures.join("; ")}`,
            );
        }
    }
}

interface ActivateClientExtensionOptions {
    readonly id: string;
    readonly path: string;
    readonly entrypointPath: string;
    readonly capabilities: readonly string[];
    readonly config: JsonValue;
    readonly preferences: ClientExtensionPreferencesAdapter;
    readonly modelSettings: ClientExtensionModelSettingsAdapter;
    readonly picker: ClientExtensionPickerAdapter;
    readonly notice: ClientExtensionNoticeAdapter;
    readonly activationTimeoutMs: number;
}

async function activateClientExtension(
    options: ActivateClientExtensionOptions,
): Promise<LoadedClientExtension> {
    const commands: RegisteredCommand[] = [];
    const keybindings: RegisteredKeybinding[] = [];
    const commandNames = new Set<string>();
    const keybindingIds = new Set<string>();
    const disposers: VeraExtensionDisposer[] = [];
    const invocationSignal = new AsyncLocalStorage<AbortSignal>();
    let statusLine: VeraClientStatusLineRenderer | undefined;
    let messageInterceptor: VeraClientMessageInterceptor | undefined;
    let phase: "activating" | "active" | "unavailable" = "activating";
    let activationCompletion: Promise<unknown> | undefined;
    let activationSettled = false;
    const hasCapability = (capability: string): boolean =>
        options.capabilities.includes(capability);
    const requireCapability = (capability: string): void => {
        if (!hasCapability(capability)) {
            throw new Error(
                `Extension ${options.id} did not declare ${capability}`,
            );
        }
    };
    const requireAvailable = (): void => {
        if (phase === "unavailable") {
            throw new Error(`Client extension ${options.id} is unavailable`);
        }
    };

    const api: VeraClientExtensionApi = Object.freeze({
        config: structuredClone(options.config),
        commands: Object.freeze({
            register(spec: VeraClientExtensionCommandSpec): void {
                requireRegistrationPhase(phase, "commands");
                requireCapability(CLIENT_COMMAND_CAPABILITY);
                validateCommandSpec(spec);
                if (commandNames.has(spec.name)) {
                    throw new Error(`Duplicate client extension command: ${spec.name}`);
                }
                commandNames.add(spec.name);
                commands.push({
                    descriptor: {
                        name: spec.name,
                        description: spec.description.trim(),
                        usage: spec.usage.trim(),
                        source: options.id,
                        ...(spec.palette === undefined
                            ? {}
                            : { palette: structuredClone(spec.palette) }),
                    },
                    run: spec.run,
                    interactive: spec.interactive === true,
                });
            },
        }),
        preferences: Object.freeze({
            async get(key: string): Promise<JsonValue | undefined> {
                requireAvailable();
                requireCapability(CLIENT_PREFERENCES_CAPABILITY);
                validatePreferenceKey(key);
                const value = await options.preferences.get(options.id, key);
                return value === undefined ? undefined : structuredClone(value);
            },
            async set(key: string, value: JsonValue): Promise<void> {
                requireAvailable();
                requireCapability(CLIENT_PREFERENCES_CAPABILITY);
                validatePreferenceKey(key);
                await options.preferences.set(
                    options.id,
                    key,
                    structuredClone(value),
                );
            },
            async delete(key: string): Promise<void> {
                requireAvailable();
                requireCapability(CLIENT_PREFERENCES_CAPABILITY);
                validatePreferenceKey(key);
                await options.preferences.delete(options.id, key);
            },
        }),
        modelSettings: Object.freeze({
            current(): VeraClientModelSettingsSnapshot | undefined {
                requireAvailable();
                requireCapability(CLIENT_MODEL_SETTINGS_CAPABILITY);
                return copySettings(options.modelSettings.current());
            },
            update(
                patch: VeraClientModelSettingsPatch,
                signal?: AbortSignal,
            ): Promise<VeraClientModelSettingsUpdateResult> {
                requireAvailable();
                requireCapability(CLIENT_MODEL_SETTINGS_CAPABILITY);
                validateSettingsPatch(patch);
                const operationSignal = signal
                    ?? invocationSignal.getStore()
                    ?? new AbortController().signal;
                return options.modelSettings.update(
                    structuredClone(patch),
                    operationSignal,
                ).then(copySettingsUpdate);
            },
            onChanged(listener: VeraClientModelSettingsListener): VeraExtensionDisposer {
                requireRegistrationPhase(phase, "model settings listeners");
                requireCapability(CLIENT_MODEL_SETTINGS_CAPABILITY);
                if (typeof listener !== "function") {
                    throw new Error("Model settings listener must be a function");
                }
                const subscribed = options.modelSettings.subscribe((settings) => {
                    listener(structuredClone(settings));
                });
                let subscribedNow = true;
                const unsubscribe = async (): Promise<void> => {
                    if (!subscribedNow) {
                        return;
                    }
                    subscribedNow = false;
                    await subscribed();
                };
                disposers.push(unsubscribe);
                return unsubscribe;
            },
            currentLevels(): readonly VeraClientReasoningLevel[] {
                requireAvailable();
                requireCapability(CLIENT_MODEL_SETTINGS_CAPABILITY);
                return currentModelLevels(options.modelSettings.current());
            },
            currentLevel(): string | undefined {
                requireAvailable();
                requireCapability(CLIENT_MODEL_SETTINGS_CAPABILITY);
                return currentModelLevel(options.modelSettings.current());
            },
            availability(
                model: { readonly provider?: string; readonly model: string },
            ): VeraClientModelAvailability {
                requireAvailable();
                requireCapability(CLIENT_MODEL_SETTINGS_CAPABILITY);
                validateModelReference(model);
                return modelAvailability(
                    options.modelSettings.current(),
                    model,
                );
            },
        }),
        ui: Object.freeze({
            requestPicker(
                request: VeraClientPickerRequest,
                signal?: AbortSignal,
            ): Promise<VeraClientPickerResult> {
                requireAvailable();
                requireCapability(CLIENT_PICKER_CAPABILITY);
                validatePickerRequest(request);
                const operationSignal = signal
                    ?? invocationSignal.getStore()
                    ?? new AbortController().signal;
                return options.picker.request(
                    options.id,
                    structuredClone(request),
                    operationSignal,
                ).then((result) => structuredClone(result));
            },
            notice(text: string): void {
                requireAvailable();
                requireCapability(CLIENT_NOTICE_CAPABILITY);
                options.notice.post(options.id, validateNoticeText(text));
            },
        }),
        keybindings: Object.freeze({
            register(spec: VeraClientExtensionKeybindingSpec): void {
                requireRegistrationPhase(phase, "keybindings");
                requireCapability(CLIENT_KEYBINDING_CAPABILITY);
                validateKeybindingSpec(spec);
                if (keybindingIds.has(spec.id)) {
                    throw new Error(`Duplicate client extension keybinding: ${spec.id}`);
                }
                keybindingIds.add(spec.id);
                keybindings.push({
                    descriptor: {
                        id: spec.id,
                        description: spec.description.trim(),
                        keys: [...spec.keys],
                        source: options.id,
                    },
                    run: spec.run,
                });
            },
        }),
        statusLine: Object.freeze({
            register(spec: VeraClientExtensionStatusLineSpec): void {
                requireRegistrationPhase(phase, "status line renderers");
                requireCapability(CLIENT_STATUS_LINE_CAPABILITY);
                validateStatusLineSpec(spec);
                if (statusLine !== undefined) {
                    throw new Error(
                        `Extension ${options.id} registered more than one status line renderer`,
                    );
                }
                statusLine = spec.render;
            },
        }),
        messages: Object.freeze({
            intercept(handler: VeraClientMessageInterceptor): void {
                requireRegistrationPhase(phase, "message interceptors");
                requireCapability(CLIENT_MESSAGE_INTERCEPT_CAPABILITY);
                if (typeof handler !== "function") {
                    throw new Error(
                        "Client extension message interceptor must be a function",
                    );
                }
                if (messageInterceptor !== undefined) {
                    throw new Error(
                        `Extension ${options.id} registered more than one message interceptor`,
                    );
                }
                messageInterceptor = handler;
            },
        }),
        onDispose(dispose: VeraExtensionDisposer): void {
            requireRegistrationPhase(phase, "disposal");
            if (typeof dispose !== "function") {
                throw new Error("Client extension disposer must be a function");
            }
            disposers.push(dispose);
        },
    });

    try {
        await runExtensionOperation(
            async () => {
                try {
                    const imported: unknown = await import(
                        pathToFileURL(options.entrypointPath).href
                    );
                    const extension = parseClientExtensionModule(imported);
                    if (extension === undefined) {
                        throw new Error(
                            "Client extension entrypoint must export an activateClient function",
                        );
                    }
                    await extension.activateClient(api);
                } finally {
                    activationSettled = true;
                }
            },
            {
                timeoutMs: options.activationTimeoutMs,
                timeoutMessage:
                    `Client extension ${options.id} activation timed out after ${options.activationTimeoutMs}ms`,
                abortMessage:
                    `Client extension ${options.id} activation was cancelled`,
                onExecutionStart(execution) {
                    activationCompletion = execution;
                },
            },
        );
        phase = "active";
    } catch (error) {
        phase = "unavailable";
        if (activationSettled) {
            await runDisposers(disposers);
        } else {
            void activationCompletion?.finally(async () => {
                await runDisposers(disposers);
            }).catch(() => undefined);
        }
        throw error;
    }

    return {
        id: options.id,
        path: options.path,
        commands,
        keybindings,
        statusLine,
        messageInterceptor,
        disposers,
        activeInvocations: new Set(),
        invocationSignal,
        markUnavailable: () => {
            phase = "unavailable";
        },
        disposing: false,
    };
}

async function invokeTracked<T>(
    extension: LoadedClientExtension,
    operation: (signal: AbortSignal) => T | Promise<T>,
    timeoutMs: number | undefined,
    label: string,
    signal?: AbortSignal,
): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
        abort();
    }
    let active: ActiveInvocation | undefined;
    try {
        return await runExtensionOperation(
            (operationSignal) => extension.invocationSignal.run(
                operationSignal,
                () => operation(operationSignal),
            ),
            {
            timeoutMs,
            timeoutMessage: `${label} timed out after ${timeoutMs ?? 0}ms`,
            abortMessage: `${label} was cancelled`,
            signal: controller.signal,
            onExecutionStart(execution) {
                active = {
                    controller,
                    completion: execution.then(
                        () => undefined,
                        () => undefined,
                    ),
                };
                extension.activeInvocations.add(active);
            },
            },
        );
    } finally {
        if (active !== undefined) {
            void active.completion.finally(() => {
                extension.activeInvocations.delete(active!);
            });
        }
        signal?.removeEventListener("abort", abort);
    }
}

async function disposeClientExtension(
    extension: LoadedClientExtension,
    timeoutMs: number,
): Promise<void> {
    if (extension.disposing) {
        return;
    }
    extension.disposing = true;
    extension.markUnavailable();
    for (const invocation of extension.activeInvocations) {
        invocation.controller.abort();
    }
    await runExtensionOperation(
        async () => {
            await Promise.all(
                [...extension.activeInvocations].map(
                    ({ completion }) => completion,
                ),
            );
            await runDisposers(extension.disposers);
        },
        {
            timeoutMs,
            timeoutMessage:
                `Client extension ${extension.id} disposal timed out after ${timeoutMs}ms`,
            abortMessage:
                `Client extension ${extension.id} disposal was cancelled`,
        },
    );
}

async function runDisposers(
    disposers: readonly VeraExtensionDisposer[],
): Promise<void> {
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
    if (failures.length > 0) {
        throw new Error(`Client extension cleanup failed: ${failures.join("; ")}`);
    }
}

function validateOwnership(
    extension: LoadedClientExtension,
    commands: ReadonlyMap<string, CommandOwner>,
    keybindings: ReadonlyMap<string, KeybindingOwner>,
    statusLine: StatusLineOwner | undefined,
    reservedCommands: ReadonlySet<string>,
    reservedKeybindings: ReadonlySet<string>,
): void {
    // One owner for the whole segment list, so the status line never becomes a
    // race between two extensions writing over each other.
    if (extension.statusLine !== undefined && statusLine !== undefined) {
        throw new Error(
            `Client extension status line from ${extension.id} collides with ${statusLine.extension.id}`,
        );
    }
    for (const command of extension.commands) {
        const name = command.descriptor.name;
        if (reservedCommands.has(name)) {
            throw new Error(
                `Client extension command /${name} from ${extension.id} is reserved`,
            );
        }
        const existing = commands.get(name);
        if (existing !== undefined) {
            throw new Error(
                `Client extension command /${name} from ${extension.id} collides with ${existing.extension.id}`,
            );
        }
    }
    const occupiedKeys = new Map<string, string>();
    for (const owner of keybindings.values()) {
        for (const key of owner.keybinding.descriptor.keys) {
            occupiedKeys.set(key, owner.extension.id);
        }
    }
    for (const keybinding of extension.keybindings) {
        const id = keybinding.descriptor.id;
        const existing = keybindings.get(id);
        if (existing !== undefined) {
            throw new Error(
                `Client extension keybinding ${id} from ${extension.id} collides with ${existing.extension.id}`,
            );
        }
        for (const key of keybinding.descriptor.keys) {
            if (reservedKeybindings.has(key)) {
                throw new Error(
                    `Client extension keybinding ${key} from ${extension.id} is reserved`,
                );
            }
            const owner = occupiedKeys.get(key);
            if (owner !== undefined) {
                throw new Error(
                    `Client extension keybinding ${key} from ${extension.id} collides with ${owner}`,
                );
            }
            occupiedKeys.set(key, extension.id);
        }
    }
}

function validateCommandSpec(spec: VeraClientExtensionCommandSpec): void {
    if (
        typeof spec !== "object"
        || spec === null
        || !isExtensionCommandName(spec.name)
        || typeof spec.description !== "string"
        || spec.description.trim().length === 0
        || typeof spec.usage !== "string"
        || spec.usage.trim().length === 0
        || (spec.interactive !== undefined
            && typeof spec.interactive !== "boolean")
        || typeof spec.run !== "function"
    ) {
        throw new Error("Invalid client extension command registration");
    }
}

function validateKeybindingSpec(
    spec: VeraClientExtensionKeybindingSpec,
): void {
    if (
        typeof spec !== "object"
        || spec === null
        || !isRegistrationId(spec.id)
        || typeof spec.description !== "string"
        || spec.description.trim().length === 0
        || !Array.isArray(spec.keys)
        || spec.keys.length === 0
        || spec.keys.some((key) =>
            typeof key !== "string" || key.trim().length === 0
        )
        || typeof spec.run !== "function"
    ) {
        throw new Error("Invalid client extension keybinding registration");
    }
}

function validateStatusLineSpec(spec: VeraClientExtensionStatusLineSpec): void {
    if (
        typeof spec !== "object"
        || spec === null
        || typeof spec.render !== "function"
    ) {
        throw new Error("Invalid client extension status line registration");
    }
}

function validatePreferenceKey(key: string): void {
    if (!isRegistrationId(key)) {
        throw new Error(`Invalid client extension preference key: ${key}`);
    }
}

function validateSettingsPatch(patch: VeraClientModelSettingsPatch): void {
    if (
        typeof patch !== "object"
        || patch === null
        || (patch.provider === undefined
            && patch.model === undefined
            && patch.reasoningEffort === undefined)
        || (patch.provider !== undefined
            && (typeof patch.provider !== "string"
                || patch.provider.trim().length === 0))
        || (patch.model !== undefined
            && (typeof patch.model !== "string"
                || patch.model.trim().length === 0))
        || (patch.reasoningEffort !== undefined
            && patch.reasoningEffort !== null
            && !isReasoningEffort(patch.reasoningEffort))
    ) {
        throw new Error("Invalid client extension model settings patch");
    }
}

function validatePickerRequest(request: VeraClientPickerRequest): void {
    if (
        typeof request !== "object"
        || request === null
        || typeof request.title !== "string"
        || request.title.trim().length === 0
        || (request.subtitle !== undefined
            && (typeof request.subtitle !== "string"
                || request.subtitle.trim().length === 0))
        || !Array.isArray(request.rows)
        || request.rows.length === 0
        || !Array.isArray(request.actions)
        || request.actions.length === 0
    ) {
        throw new Error("Invalid client extension picker request");
    }
    const rowIds = new Set<string>();
    for (const row of request.rows) {
        if (
            !isRegistrationId(row.id)
            || rowIds.has(row.id)
            || typeof row.label !== "string"
            || row.label.trim().length === 0
        ) {
            throw new Error("Invalid client extension picker row");
        }
        rowIds.add(row.id);
    }
    const actionIds = new Set<string>();
    for (const action of request.actions) {
        if (
            !isRegistrationId(action.id)
            || actionIds.has(action.id)
            || typeof action.label !== "string"
            || action.label.trim().length === 0
            || !Array.isArray(action.keys)
            || action.keys.length === 0
        ) {
            throw new Error("Invalid client extension picker action");
        }
        actionIds.add(action.id);
    }
    if (
        request.selectedId !== undefined
        && !rowIds.has(request.selectedId)
    ) {
        throw new Error("Client extension picker selectedId is not a row");
    }
}

function parseClientExtensionModule(
    value: unknown,
): VeraClientExtensionModule | undefined {
    if (
        typeof value !== "object"
        || value === null
        || !("activateClient" in value)
        || typeof value.activateClient !== "function"
    ) {
        return undefined;
    }
    return {
        activateClient:
            value.activateClient as VeraClientExtensionModule["activateClient"],
    };
}

function requireRegistrationPhase(
    phase: "activating" | "active" | "unavailable",
    contribution: string,
): void {
    if (phase !== "activating") {
        throw new Error(
            `Client extension ${contribution} must be registered during activation`,
        );
    }
}

function isRegistrationId(value: string): boolean {
    return typeof value === "string"
        && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function isReasoningEffort(value: unknown): boolean {
    return typeof value === "string" && value.length > 0;
}

function copySettings(
    settings: VeraClientModelSettingsSnapshot | undefined,
): VeraClientModelSettingsSnapshot | undefined {
    return settings === undefined ? undefined : structuredClone(settings);
}

function copySettingsUpdate(
    result: VeraClientModelSettingsUpdateResult,
): VeraClientModelSettingsUpdateResult {
    return structuredClone(result);
}

// A model missing from `availableModels` (unrecognised, or reached through
// an escape hatch such as `/model <name>`) reads the same as a model with an
// empty `levels` array: no facts about it have reached the client, so there
// is nothing to cycle either way.
function currentModelLevels(
    settings: VeraClientModelSettingsSnapshot | undefined,
): readonly VeraClientReasoningLevel[] {
    const current = currentAvailableModel(settings);
    return current === undefined ? [] : structuredClone(current.levels);
}

// Placement runs through `inferReasoningSelection` rather than a local match
// so an extension sees exactly the level the turn will run at, and so this
// rule stays stated in one place. `providerEffort` is absent only when the
// model has no usable level, which is the same case as an empty level list.
function currentModelLevel(
    settings: VeraClientModelSettingsSnapshot | undefined,
): string | undefined {
    const current = currentAvailableModel(settings);
    if (current === undefined || current.levels.length === 0) {
        return undefined;
    }
    return inferReasoningSelection(
        settings?.reasoningEffort ?? "",
        current.levels.map((level) => level.id),
        current.defaultLevel,
    ).providerEffort;
}

/**
 * A model is runnable when a connected provider offers it, which is the same
 * test the picker's All models tab applies to a row. A pooled entry that cannot
 * run keeps its row there and is not runnable here.
 */
function modelAvailability(
    settings: VeraClientModelSettingsSnapshot | undefined,
    model: { readonly provider?: string; readonly model: string },
): VeraClientModelAvailability {
    const matches = (candidate: { provider: string; model: string }): boolean =>
        candidate.model === model.model
        && (model.provider === undefined
            || candidate.provider === model.provider);
    const pooled = (settings?.pooled ?? []).find(matches);
    const offered = (settings?.availableModels ?? []).some(matches);
    return {
        runnable: offered || pooled?.available === true,
        pooled: pooled !== undefined,
        verified: pooled?.verified === true,
    };
}

function validateModelReference(
    model: { readonly provider?: string; readonly model: string },
): void {
    if (
        typeof model !== "object" || model === null
        || typeof model.model !== "string" || model.model.length === 0
        || (model.provider !== undefined && typeof model.provider !== "string")
    ) {
        throw new Error("Invalid client extension model reference");
    }
}

function validateNoticeText(text: string): string {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) {
        throw new Error("Client extension notice text must not be empty");
    }
    return trimmed;
}

function currentAvailableModel(
    settings: VeraClientModelSettingsSnapshot | undefined,
): VeraClientAvailableModel | undefined {
    return (settings?.availableModels ?? []).find((candidate) =>
        candidate.provider === settings?.provider
        && candidate.model === settings?.model
    );
}

function safelyReportFailure(
    report: StartClientExtensionRegistryOptions["onFailure"],
    failure: ClientExtensionRegistryFailure,
): void {
    try {
        report?.(failure);
    } catch {
        // Optional reporting cannot affect extension lifecycle.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * An absent decision is `pass`: an interceptor that only wanted to look at the
 * message returns nothing, and that must not swallow it.
 */
function parseMessageDecision(
    value: unknown,
): VeraClientMessageDecision | undefined {
    if (value === undefined || value === null) {
        return { kind: "pass" };
    }
    if (typeof value !== "object") {
        return undefined;
    }
    const kind = Reflect.get(value, "kind");
    if (kind === "pass" || kind === "handled") {
        return { kind };
    }
    if (kind !== "replace") {
        return undefined;
    }
    const text = Reflect.get(value, "text");
    return typeof text === "string" && text.trim().length > 0
        ? { kind: "replace", text }
        : undefined;
}
