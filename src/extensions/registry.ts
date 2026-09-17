import { isExtensionSessionState, type ExtensionSessionState, type ExtensionSessionStates } from "./session-state.ts";
import { pathToFileURL } from "node:url";
import type { ModelMiddleware } from "../sdk/model-middleware.ts";

import type { VeraExtensionConfig } from "../config.ts";
import type {
    ToolPresentation,
} from "../model/types.ts";
import {
    applyWatchConfigOverrides,
    stripWatchConfigOverrides,
} from "./contributions.ts";
import { resolveEnvReferences } from "./env-refs.ts";
import {
    findLiteralSecrets,
    type LiteralSecretFinding,
} from "./literal-secret.ts";
import { extensionStorage } from "./storage.ts";
import type {
    VeraExtensionApi,
    VeraExtensionCommandHandler,
    VeraExtensionCommandSpec,
    VeraExtensionCommandHookSpec,
    VeraExtensionDisposer,
    VeraExtensionModule,
    VeraExtensionToolHandler,
    VeraExtensionAgentSpec,
    VeraExtensionToolSpec,
    SessionIdentityProvider,
} from "../sdk/extensions.ts";
import type {
    ModelRequestHook,
    PostToolUseHook,
    PostToolUseHookPayload,
    PostToolUseHookResult,
    PreToolUseHook,
    PreToolUseHookPayload,
    PreToolUseHookResult,
    PreTurnHook,
    SessionStartHook,
    PreTurnHookPayload,
    PreTurnHookResult,
    RegisteredModelRequestHook,
} from "../sdk/hooks.ts";
import { createCommandHook, type CommandHookSpec } from "./command-hook.ts";
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
const MAX_HANDLER_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
const MAX_EXTENSION_PRESENTATION_BYTES = 64 * 1024;
const MAX_EXTENSION_HOOK_BYTES = 64 * 1024;
const MAX_EXTENSION_DIFF_LINES = 400;
const PRE_TOOL_HOOK_CAPABILITY = "hooks.pre_tool_use";
const POST_TOOL_HOOK_CAPABILITY = "hooks.post_tool_use";
const SESSION_START_HOOK_CAPABILITY = "hooks.session_start";
const PRE_TURN_HOOK_CAPABILITY = "hooks.pre_turn";
const MODEL_REQUEST_HOOK_CAPABILITY = "hooks.model_request";
const SESSION_IDENTITY_CAPABILITY = "sessions.identity";

export interface StartExtensionRegistryOptions {
    readonly extensions: readonly VeraExtensionConfig[];
    readonly activationTimeoutMs?: number;
    readonly handlerTimeoutMs?: number;
    readonly disposeTimeoutMs?: number;
    readonly onFailure?: (failure: ExtensionRegistryFailure) => void;
    readonly onLiteralSecret?: (finding: LiteralSecretFinding) => void;
    readonly onActivationTiming?: (timing: {
        readonly extensionId: string;
        readonly durationMs: number;
        readonly outcome: "loaded" | "failed";
    }) => void;
}

import {
    parseAgentDefinition,
    type AgentDefinition,
} from "../agents/definition.ts";

export interface ExtensionRegistryFailure {
    readonly path: string;
    readonly extensionId?: string;
    readonly message: string;
}

export interface ExtensionRegistry {
    sessionState(sessionId: string): ExtensionSessionStates;
    modelMiddleware(): readonly ModelMiddleware[];
    commands(): readonly ExtensionCommandDescriptor[];
    tools(): readonly RegisteredTool[];
    agents(): readonly AgentDefinition[];
    preToolUseHooks(): readonly PreToolUseHook[];
    postToolUseHooks(): readonly PostToolUseHook[];
    preTurnHooks(): readonly PreTurnHook[];
    sessionStartHooks(): readonly SessionStartHook[];
    modelRequestHooks(): readonly RegisteredModelRequestHook[];
    sessionIdentity(): SessionIdentityProvider | undefined;
    contributions(): HostContributionSet;
    invokeCommand(
        name: string,
        argumentsText: string,
        workspace: string,
        signal?: AbortSignal,
        sessionId?: string,
        sessionPath?: string,
    ): Promise<ExtensionCommandResult>;
    close(): Promise<void>;
}

interface RegisteredExtensionCommand {
    readonly descriptor: ExtensionCommandDescriptor;
    readonly timeoutMs: number;
    readonly run: VeraExtensionCommandHandler;
}

interface RegisteredExtensionTool {
    readonly tool: RegisteredTool;
    readonly run: VeraExtensionToolHandler;
}

interface LoadedRegistryExtension {
    readonly sessionState: ((sessionId: string) => ExtensionSessionState)[];
    readonly modelMiddleware: readonly ModelMiddleware[];
    readonly id: string;
    readonly path: string;
    readonly commands: readonly RegisteredExtensionCommand[];
    readonly tools: readonly RegisteredExtensionTool[];
    readonly agents: readonly AgentDefinition[];
    readonly preToolUseHooks: readonly PreToolUseHook[];
    readonly postToolUseHooks: readonly PostToolUseHook[];
    readonly preTurnHooks: readonly PreTurnHook[];
    readonly sessionStartHooks: readonly SessionStartHook[];
    readonly modelRequestHooks: readonly RegisteredModelRequestHook[];
    readonly identityProvider?: SessionIdentityProvider;
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
    const modelRequestNamespaces = new Set<string>();
    let identityOwner: string | undefined;
    const contributions = createHostContributionSet();
    let closing: Promise<void> | undefined;

    for (const configured of options.extensions) {
        if (!configured.enabled) {
            continue;
        }

        let extension: LoadedRegistryExtension | undefined;
        let extensionId: string | undefined;
        let admitted = false;
        const activationStarted = performance.now();
        let activationOutcome: "loaded" | "failed" = "failed";
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
            for (const finding of findLiteralSecrets(
                configured.config,
                manifest.manifest.id,
            )) {
                safelyReportLiteralSecret(options.onLiteralSecret, finding);
            }
            const resolvedConfig = resolveEnvReferences(
                configured.config,
                manifest.manifest.id,
            ) as typeof configured.config;
            contributions.admit(
                manifest.manifest.id,
                applyWatchConfigOverrides(
                    manifest.manifest.contributes,
                    resolvedConfig,
                    manifest.manifest.id,
                ),
                manifest.directory,
            );
            admitted = true;
            extension = await activateExtension(
                manifest,
                stripWatchConfigOverrides(resolvedConfig) as typeof configured.config,
                activationTimeoutMs,
                handlerTimeoutMs,
                disposeTimeoutMs,
            );
            validateCommandOwnership(extension, commands);
            validateToolOwnership(extension, tools);
            for (const hook of extension.modelRequestHooks) {
                if (modelRequestNamespaces.has(hook.namespace)) {
                    throw new Error(
                        `Duplicate model request namespace: ${hook.namespace}`,
                    );
                }
            }
            if (
                extension.identityProvider !== undefined
                && identityOwner !== undefined
            ) {
                throw new Error(
                    `Duplicate session identity provider: ${identityOwner}`,
                );
            }
            loaded.push(extension);
            activationOutcome = "loaded";
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
            for (const hook of extension.modelRequestHooks) {
                modelRequestNamespaces.add(hook.namespace);
            }
            if (extension.identityProvider !== undefined) {
                identityOwner = extension.id;
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

        } finally {
            options.onActivationTiming?.({
                extensionId: extensionId ?? configured.path,
                durationMs: performance.now() - activationStarted,
                outcome: activationOutcome,
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
        agents(): readonly AgentDefinition[] {
            return loaded.flatMap((extension) => extension.agents);
        },
        preToolUseHooks(): readonly PreToolUseHook[] {
            return loaded.flatMap((extension) => extension.preToolUseHooks);
        },
        postToolUseHooks(): readonly PostToolUseHook[] {
            return loaded.flatMap((extension) => extension.postToolUseHooks);
        },
        sessionStartHooks(): readonly SessionStartHook[] {
            return loaded.flatMap((extension) => extension.sessionStartHooks);
        },
        preTurnHooks(): readonly PreTurnHook[] {
            return loaded.flatMap((extension) => extension.preTurnHooks);
        },
        modelRequestHooks(): readonly RegisteredModelRequestHook[] {
            return loaded.flatMap((extension) => extension.modelRequestHooks);
        },
        sessionState(sessionId): ExtensionSessionStates {
            const states: Record<string, ExtensionSessionState> = {};
            for (const extension of loaded) {
                if (extension.disposing) continue;
                for (const read of extension.sessionState) {
                    try {
                        const state = read(sessionId);
                        if (isExtensionSessionState(state) && JSON.stringify(state).length <= 4096) {
                            states[extension.id] = structuredClone(state);
                        }
                    } catch {}
                }
            }
            return states;
        },
        modelMiddleware(): readonly ModelMiddleware[] {
            return loaded.flatMap((extension) => extension.modelMiddleware);
        },
        sessionIdentity(): SessionIdentityProvider | undefined {
            return loaded.find(
                (extension) =>
                    extension.identityProvider !== undefined
                    && !extension.disposing,
            )?.identityProvider;
        },
        async invokeCommand(
            name: string,
            argumentsText: string,
            workspace: string,
            signal?: AbortSignal,
            sessionId?: string,
            sessionPath?: string,
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
                        ...(sessionId === undefined ? {} : { sessionId }),
                        ...(sessionPath === undefined ? {} : { sessionPath }),
                    }),
                    {
                        timeoutMs: owner.command.timeoutMs,
                        timeoutMessage:
                            `Extension ${owner.extension.id}/${name} timed out after ${owner.command.timeoutMs}ms`,
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
        modelRequestNamespaces.clear();
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
    const agents: AgentDefinition[] = [];
    const agentNames = new Set<string>();
    const preToolUseHooks: PreToolUseHook[] = [];
    const postToolUseHooks: PostToolUseHook[] = [];
    const preTurnHooks: PreTurnHook[] = [];
    const sessionStartHooks: SessionStartHook[] = [];
    const modelRequestHooks: RegisteredModelRequestHook[] = [];
    const sessionState: ((sessionId: string) => ExtensionSessionState)[] = [];
    const modelMiddleware: ModelMiddleware[] = [];
    let identityProvider: SessionIdentityProvider | undefined;
    const toolNames = new Set<string>();
    const disposers: VeraExtensionDisposer[] = [];
    const activeInvocations = new Set<ActiveExtensionInvocation>();
    let phase: "activating" | "active" | "failed" = "activating";
    let activationCompletion: Promise<unknown> | undefined;
    let activationSettled = false;
    const api: VeraExtensionApi = Object.freeze({
        config: structuredClone(config),
        storage: extensionStorage(loaded.manifest.id),
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
                    handlerTimeoutMs,
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
        agents: Object.freeze({
            register(spec: VeraExtensionAgentSpec): void {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension agents must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes("agents.register")) {
                    throw new Error(
                        "Extension did not declare agents.register",
                    );
                }
                const definition = parseExtensionAgent(spec);
                if (agentNames.has(definition.name)) {
                    throw new Error(
                        `Duplicate extension agent: ${definition.name}`,
                    );
                }
                agentNames.add(definition.name);
                agents.push(definition);
            },
        }),
        sessions: Object.freeze({
            registerState(read: (sessionId: string) => ExtensionSessionState): VeraExtensionDisposer {
                if (phase !== "activating" || !loaded.manifest.capabilities.includes("sessions.state")) {
                    throw new Error("Session state requires sessions.state during activation");
                }
                if (typeof read !== "function" || sessionState.length > 0) {
                    throw new Error("Invalid or duplicate session state reader");
                }
                sessionState.push(read);
                return () => removeHook(sessionState, read);
            },
            registerIdentity(provider: SessionIdentityProvider): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension session identity must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes(SESSION_IDENTITY_CAPABILITY)) {
                    throw new Error(
                        `Extension did not declare ${SESSION_IDENTITY_CAPABILITY}`,
                    );
                }
                if (
                    typeof provider !== "object"
                    || provider === null
                    || typeof provider.mint !== "function"
                    || (
                        provider.keyOf !== undefined
                        && typeof provider.keyOf !== "function"
                    )
                ) {
                    throw new Error("Invalid session identity registration");
                }
                if (identityProvider !== undefined) {
                    throw new Error("Duplicate session identity provider");
                }
                identityProvider = provider;
                return () => {
                    if (identityProvider === provider) {
                        identityProvider = undefined;
                    }
                };
            },
        }),
        hooks: Object.freeze({
            registerModelMiddleware(middleware: ModelMiddleware): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error("Model middleware must be registered during activation");
                }
                if (!loaded.manifest.capabilities.includes("hooks.model_middleware")) {
                    throw new Error("Extension did not declare hooks.model_middleware");
                }
                if (typeof middleware !== "function") throw new Error("Invalid model middleware");
                modelMiddleware.push(middleware);
                return () => removeHook(modelMiddleware, middleware);
            },
            registerPreToolUse(hook: PreToolUseHook): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension hooks must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes(PRE_TOOL_HOOK_CAPABILITY)) {
                    throw new Error(
                        `Extension did not declare ${PRE_TOOL_HOOK_CAPABILITY}`,
                    );
                }
                if (typeof hook !== "function") {
                    throw new Error("Invalid pre-tool hook registration");
                }
                const safe = safePreToolHook(hook);
                preToolUseHooks.push(safe);
                return () => removeHook(preToolUseHooks, safe);
            },
            registerPostToolUse(hook: PostToolUseHook): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension hooks must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes(POST_TOOL_HOOK_CAPABILITY)) {
                    throw new Error(
                        `Extension did not declare ${POST_TOOL_HOOK_CAPABILITY}`,
                    );
                }
                if (typeof hook !== "function") {
                    throw new Error("Invalid post-tool hook registration");
                }
                const safe = safePostToolHook(hook);
                postToolUseHooks.push(safe);
                return () => removeHook(postToolUseHooks, safe);
            },
            registerSessionStart(hook: SessionStartHook): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error("Extension hooks must be registered during activation");
                }
                if (!loaded.manifest.capabilities.includes(SESSION_START_HOOK_CAPABILITY)) {
                    throw new Error(`Extension did not declare ${SESSION_START_HOOK_CAPABILITY}`);
                }
                if (typeof hook !== "function") {
                    throw new Error("Invalid session-start hook registration");
                }
                sessionStartHooks.push(hook);
                return () => removeHook(sessionStartHooks, hook);
            },
            registerPreTurn(hook: PreTurnHook): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension hooks must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes(PRE_TURN_HOOK_CAPABILITY)) {
                    throw new Error(
                        `Extension did not declare ${PRE_TURN_HOOK_CAPABILITY}`,
                    );
                }
                if (typeof hook !== "function") {
                    throw new Error("Invalid pre-turn hook registration");
                }
                const safe = safePreTurnHook(hook);
                preTurnHooks.push(safe);
                return () => removeHook(preTurnHooks, safe);
            },
            registerModelRequest(
                namespace: string,
                hook: ModelRequestHook,
            ): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension hooks must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes(MODEL_REQUEST_HOOK_CAPABILITY)) {
                    throw new Error(
                        `Extension did not declare ${MODEL_REQUEST_HOOK_CAPABILITY}`,
                    );
                }
                if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) {
                    throw new Error("Invalid model request namespace");
                }
                if (typeof hook !== "function") {
                    throw new Error("Invalid model request hook registration");
                }
                if (modelRequestHooks.some((entry) => entry.namespace === namespace)) {
                    throw new Error(
                        `Duplicate model request namespace: ${namespace}`,
                    );
                }
                const registered = { namespace, run: hook };
                modelRequestHooks.push(registered);
                return () => removeHook(modelRequestHooks, registered);
            },
            registerCommand(spec: VeraExtensionCommandHookSpec): VeraExtensionDisposer {
                if (phase !== "activating") {
                    throw new Error(
                        "Extension hooks must be registered during activation",
                    );
                }
                if (!loaded.manifest.capabilities.includes("hooks.command")) {
                    throw new Error("Extension did not declare hooks.command");
                }
                const command = normalizeCommandHookSpec(spec);
                const hook = createCommandHook(command);
                if (command.phase === "session_start") {
                    const startHook = hook as SessionStartHook;
                    sessionStartHooks.push(startHook);
                    return () => removeHook(sessionStartHooks, startHook);
                }
                if (command.phase === "pre_tool_use") {
                    const safe = safePreToolHook(hook as PreToolUseHook);
                    preToolUseHooks.push(safe);
                    return () => removeHook(preToolUseHooks, safe);
                }
                const safe = safePostToolHook(hook as PostToolUseHook);
                postToolUseHooks.push(safe);
                return () => removeHook(postToolUseHooks, safe);
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
            agents,
            preToolUseHooks,
            postToolUseHooks,
            preTurnHooks,
            sessionStartHooks,
            modelRequestHooks,
            sessionState,
            modelMiddleware,
            ...(identityProvider === undefined
                ? {}
                : { identityProvider }),
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
        invocation,
        timeoutMs,
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
        || (invocation !== undefined && invocation !== "top_level")
        || !validHandlerTimeout(timeoutMs)
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
        ...(invocation === undefined ? {} : { invocation }),
        ...(parallel === undefined ? {} : { parallel }),
        ...(permissionOperation === undefined
            ? {}
            : { permissionOperation: permissionOperation.trim() }),
        ...(permissionInputs === undefined
            ? {}
            : { permissionInputs: structuredClone(permissionInputs) }),
        async execute(input, context, signal) {
            if (invocation === "top_level" && context.invocation !== "top_level") {
                return {
                    kind: "output",
                    output: `The ${name} tool is available only to top-level sessions.`,
                    isError: true,
                };
            }
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
                        timeoutMs: timeoutMs ?? handlerTimeoutMs,
                        timeoutMessage:
                            `Extension ${loaded.manifest.id}/${name} timed out after ${timeoutMs ?? handlerTimeoutMs}ms`,
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
                || (result.imagePaths !== undefined && (!Array.isArray(result.imagePaths)
                    || result.imagePaths.length > 4
                    || result.imagePaths.some((path) => typeof path !== "string" || path.trim().length === 0)))
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
                ...(result.imagePaths === undefined ? {} : { imagePaths: [...result.imagePaths] as string[] }),
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
    handlerTimeoutMs: number,
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
        timeoutMs,
        run,
    } = spec;
    if (
        typeof name !== "string"
        || !isExtensionCommandName(name)
        || typeof description !== "string"
        || description.trim().length === 0
        || typeof usage !== "string"
        || usage.trim().length === 0
        || !validHandlerTimeout(timeoutMs)
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
        timeoutMs: timeoutMs ?? handlerTimeoutMs,
        run,
    });
}

function validHandlerTimeout(value: unknown): boolean {
    return value === undefined
        || (typeof value === "number"
            && Number.isInteger(value)
            && value > 0
            && value <= MAX_HANDLER_TIMEOUT_MS);
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

function normalizeCommandHookSpec(
    spec: VeraExtensionCommandHookSpec,
): CommandHookSpec {
    if (typeof spec !== "object" || spec === null) {
        throw new Error("Invalid command hook registration");
    }
    return {
        phase: spec.phase,
        argv: [...(spec.argv ?? [])],
        ...(spec.protocol === undefined ? {} : { protocol: spec.protocol }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    };
}

function safePreToolHook(hook: PreToolUseHook): PreToolUseHook {
    return async (payload: PreToolUseHookPayload): Promise<PreToolUseHookResult> => {
        try {
            const result = await hook(structuredClone(payload));
            return isPreToolUseResult(result) ? structuredClone(result) : { power: "observe" };
        } catch {
            return { power: "observe" };
        }
    };
}

function safePostToolHook(hook: PostToolUseHook): PostToolUseHook {
    return async (payload: PostToolUseHookPayload): Promise<PostToolUseHookResult> => {
        try {
            const result = await hook(structuredClone(payload));
            return isPostToolUseResult(result) ? structuredClone(result) : { power: "observe" };
        } catch {
            return { power: "observe" };
        }
    };
}

function safePreTurnHook(hook: PreTurnHook): PreTurnHook {
    return async (payload: PreTurnHookPayload): Promise<PreTurnHookResult> => {
        try {
            const result = await hook(structuredClone(payload));
            return isPreTurnResult(result) ? structuredClone(result) : { power: "observe" };
        } catch {
            return { power: "observe" };
        }
    };
}

function isPreToolUseResult(value: unknown): value is PreToolUseHookResult {
    if (!isPlainObject(value) || typeof value.power !== "string") return false;
    if (value.power === "observe") return true;
    if (value.power === "mutate") {
        return isPlainObject(value.input)
            && boundedHookData(value.input);
    }
    if (value.power === "block") {
        return typeof value.reason === "string"
            && value.reason.length > 0
            && boundedHookData(value.reason);
    }
    return value.power === "replace"
        && isToolResultValue(value.result)
        && boundedHookData(value.result);
}

function isPostToolUseResult(value: unknown): value is PostToolUseHookResult {
    if (!isPlainObject(value) || typeof value.power !== "string") return false;
    if (value.power === "observe") return true;
    if (value.power !== "mutate" || !isPlainObject(value.patch)) return false;
    const patch = value.patch;
    return (patch.content === undefined || isHookTextContentArray(patch.content))
        && (patch.content === undefined || boundedHookData(patch.content))
        && (patch.isError === undefined || typeof patch.isError === "boolean");
}

function isPreTurnResult(value: unknown): value is PreTurnHookResult {
    if (!isPlainObject(value) || typeof value.power !== "string") return false;
    if (value.power === "observe") return true;
    if (value.power === "block") {
        return typeof value.reason === "string"
            && value.reason.length > 0
            && boundedHookData(value.reason);
    }
    if (value.power !== "mutate") return false;
    if (value.tools !== undefined) {
        if (
            !Array.isArray(value.tools)
            || value.tools.some((name) => typeof name !== "string" || name.length === 0)
            || !boundedHookData(value.tools)
        ) {
            return false;
        }
    }
    if (value.model !== undefined) {
        if (typeof value.model !== "string" || value.model.length === 0) {
            return false;
        }
    }
    if (value.reasoningEffort !== undefined) {
        if (
            typeof value.reasoningEffort !== "string"
            || value.reasoningEffort.length === 0
        ) {
            return false;
        }
    }
    return true;
}

function boundedHookData(value: unknown): boolean {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8")
            <= MAX_EXTENSION_HOOK_BYTES;
    } catch {
        return false;
    }
}

function isToolResultValue(value: unknown): boolean {
    return isPlainObject(value)
        && typeof value.isError === "boolean"
        && isHookTextContentArray(value.content);
}

function isHookTextContentArray(value: unknown): boolean {
    return Array.isArray(value)
        && value.every((item) =>
            isPlainObject(item)
            && item.type === "text"
            && typeof item.text === "string"
        );
}

function removeHook<Hook>(hooks: Hook[], hook: Hook): void {
    const index = hooks.indexOf(hook);
    if (index !== -1) hooks.splice(index, 1);
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

function safelyReportLiteralSecret(
    report: StartExtensionRegistryOptions["onLiteralSecret"],
    finding: LiteralSecretFinding,
): void {
    try {
        report?.(finding);
    } catch {
    }
}

function safelyReportFailure(
    report: StartExtensionRegistryOptions["onFailure"],
    failure: ExtensionRegistryFailure,
): void {
    try {
        report?.(failure);
    } catch {
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseExtensionAgent(spec: VeraExtensionAgentSpec): AgentDefinition {
    if (
        typeof spec !== "object" || spec === null
        || typeof spec.name !== "string"
        || typeof spec.instructions !== "string"
    ) {
        throw new Error("Invalid extension agent registration");
    }
    const frontmatter: Record<string, unknown> = {
        ...(spec.description === undefined
            ? {}
            : { description: spec.description }),
        ...(spec.tools === undefined ? {} : { tools: spec.tools }),
        ...(spec.skills === undefined ? {} : { skills: spec.skills }),
        ...(spec.posture === undefined ? {} : { posture: spec.posture }),
        ...(spec.forbiddenAccess === undefined
            ? {}
            : { forbidden_access: spec.forbiddenAccess }),
        ...(spec.defaultPair === undefined
            ? {}
            : { default_pair: spec.defaultPair }),
        ...(spec.subagentAssignment === undefined ? {} : {
            subagent_assignment: spec.subagentAssignment,
        }),
        ...(spec.nudges === undefined ? {} : { nudges: spec.nudges }),
    };
    return parseAgentDefinition(
        spec.name,
        `---\n${JSON.stringify(frontmatter)}\n---\n${spec.instructions}`,
    );
}
