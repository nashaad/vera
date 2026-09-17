import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    defineAgent,
    DEFAULT_AGENT,
    type AgentDefinition,
} from "../agents/definition.ts";
import {
    findCatalogAgent,
    loadAgentCatalog,
} from "../agents/catalog.ts";
import { resolveAgentSnapshot } from "../agents/snapshot.ts";
import {
    configuredModelFallback,
    createLiveVeraConfigReader,
    loadOptionalVeraConfig,
    VERA_CONFIG_SCHEMA_VERSION,
    type VeraConfig,
} from "../config.ts";
import {
    BUILT_IN_PERMISSION_MODE_NAMES,
    builtInPermissionMode,
} from "../engine/permissions.ts";
import type { SessionModelUsage } from "../engine/protocol.ts";
import {
    isConfigurationRequiredUiRequestUpdate,
    isToolApprovalUiRequestUpdate,
    isUserQuestionUiRequestUpdate,
    type UiRequestUpdate,
} from "../engine/protocol.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import { SessionStore } from "../store/session-store.ts";
import { ToolHooks } from "../engine/hooks.ts";
import type { PreTurnHook } from "./hooks.ts";
import {
    ResidentAgent,
    ResidentAgentClosedError,
    type AgentAttachment,
} from "../host/resident-agent.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { splitModelId } from "../model/pool-file.ts";
import { resolvePoolRef } from "../model/pool-names.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
    ModelSubstitution,
} from "../model/types.ts";
import {
    veraProfileDirectory,
} from "../profile-paths.ts";
import { createAuthStorage, type AuthStorage } from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";
import {
    applyModelRequestOptions,
    ProviderRoutingAdapter,
} from "../providers/routing.ts";

export interface VeraCreateOptions {
    /** Default workspace for agents created by this Vera instance. */
    readonly workspace?: string;
    /** Permission ceiling shared by every binding from this runtime. */
    readonly posture?: string;
    /** An already parsed config, primarily for embedding and tests. */
    readonly config?: VeraConfig;
    /** Adapter construction seam for custom runtimes and deterministic tests. */
    readonly createAdapter?: (
        config: VeraConfig,
        workspace: string,
    ) => ModelAdapter;
}

/**
 * One hostless bounded turn against the daily home. Config and credentials
 * are read; the only write is this run's temporary session directory.
 */
export interface VeraRunOptions<Output = never> {
    readonly prompt: string;
    readonly agent?: AgentDefinition | string;
    readonly workspace?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly effort?: ModelReasoningEffort;
    readonly posture?: string;
    readonly tools?: readonly string[];
    readonly signal?: AbortSignal;
    readonly output?: AgentOutputSchema<Output>;
    readonly config?: VeraConfig;
    readonly createAdapter?: (
        config: VeraConfig,
        workspace: string,
    ) => ModelAdapter;
    readonly sessionPath?: string;
}

/** Runtime overrides applied while binding one shared agent definition. */
export interface VeraAgentOptions {
    readonly workspace?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

/** Minimal parser contract implemented by schema libraries and plain objects. */
export interface AgentOutputSchema<Output> {
    readonly parse: (value: unknown) => Output;
}

export interface AgentRunOptions<Output = never> {
    readonly signal?: AbortSignal;
    readonly output?: AgentOutputSchema<Output>;
    /**
     * Once per user turn, after the prompt is committed and before the first
     * model call. May observe, restrict tools, change model or effort, or
     * block the turn. It cannot rewrite messages or the system prompt.
     */
    readonly prepareTurn?: PreTurnHook;
    /** Durable SessionStore path. Omitted means a temporary file that is deleted. */
    readonly sessionPath?: string;
}

export type AgentRunOutcome = "completed" | "failed" | "aborted";
export type AgentRunErrorKind = "model" | "runtime" | "aborted" | "schema";

export interface AgentRunModelIdentity {
    readonly provider: string;
    readonly model: string;
}

export interface AgentRunResult<Output = never> {
    readonly outcome: AgentRunOutcome;
    readonly text: string;
    readonly output?: Output;
    readonly model: AgentRunModelIdentity;
    readonly usage?: SessionModelUsage;
    readonly substitutions: readonly ModelSubstitution[];
    readonly error?: AgentRunError;
}

export interface AgentRunError {
    readonly kind: AgentRunErrorKind;
    readonly message: string;
}

interface BoundAgentOptions {
    readonly definition: AgentDefinition | string;
    readonly binding: VeraAgentOptions;
    readonly workspace: string;
    readonly profileDirectory: string;
    readonly config: VeraConfig;
    readonly runtimePosture: string;
    readonly createAdapter: (config: VeraConfig, workspace: string) => ModelAdapter;
    readonly readRequestOptionsConfig: () => VeraConfig;
}

interface ResolvedAgentOptions {
    readonly definition: AgentDefinition;
    readonly workspace: string;
    readonly config: VeraConfig;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly posture: string;
    readonly createAdapter: (config: VeraConfig, workspace: string) => ModelAdapter;
    readonly readRequestOptionsConfig: () => VeraConfig;
}

interface ResolvedDefaultPair {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

/**
 * Host-independent Vera runtime for ordinary application code.
 *
 * This sits above the engine loop and below workflow policy. Application code
 * owns sequence, branching, and concurrency. Each run owns one bounded turn.
 */
export class Vera {
    private constructor(
        private readonly config: VeraConfig,
        private readonly workspace: string,
        private readonly profileDirectory: string,
        private readonly runtimePosture: string,
        private readonly createAdapter: (
            config: VeraConfig,
            workspace: string,
        ) => ModelAdapter,
        private readonly readRequestOptionsConfig: () => VeraConfig,
    ) {}

    static async create(options: VeraCreateOptions = {}): Promise<Vera> {
        const workspace = options.workspace ?? process.cwd();
        const profileDirectory = veraProfileDirectory();
        const config = options.config
            ?? homeConfig(profileDirectory, workspace);
        const readRequestOptionsConfig = options.config === undefined
            ? createLiveVeraConfigReader(config, {
                path: join(profileDirectory, "config.json"),
                projectRoot: workspace,
            })
            : () => config;
        const runtimePosture = options.posture ?? config.approval_mode;
        requirePermissionMode(runtimePosture, config);
        return new Vera(
            config,
            workspace,
            profileDirectory,
            runtimePosture,
            options.createAdapter ?? defaultAdapterFactory(),
            readRequestOptionsConfig,
        );
    }

    /**
     * One bounded turn with no resident host and no socket. Reads the daily
     * home. Does not call `create()`.
     */
    static async run<Output = never>(
        options: VeraRunOptions<Output>,
    ): Promise<AgentRunResult<Output>> {
        if (options.prompt.trim().length === 0) {
            throw new Error("Agent prompt must not be empty");
        }
        const workspace = options.workspace ?? process.cwd();
        const profileDirectory = veraProfileDirectory();
        const config = options.config
            ?? homeConfig(profileDirectory, workspace);
        const runtimePosture = options.posture ?? config.approval_mode;
        requirePermissionMode(runtimePosture, config);
        const vera = new Vera(
            config,
            workspace,
            profileDirectory,
            runtimePosture,
            options.createAdapter ?? defaultRunAdapterFactory(),
            () => config,
        );
        const definition = options.agent ?? (
            options.tools === undefined
                ? DEFAULT_AGENT
                : { ...DEFAULT_AGENT, tools: options.tools }
        );
        const result = await vera.agent(definition, {
            workspace,
            ...(options.provider === undefined ? {} : { provider: options.provider }),
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.effort === undefined
                ? {}
                : { reasoningEffort: options.effort }),
        }).run(options.prompt, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.output === undefined ? {} : { output: options.output }),
            ...(options.sessionPath === undefined
                ? {}
                : { sessionPath: options.sessionPath }),
        });
        return mapCredentialFailure(result);
    }

    agent(
        definition: AgentDefinition | string,
        options: VeraAgentOptions = {},
    ): Agent {
        const normalized = typeof definition === "string"
            ? definition
            : bindableDefinition(
                isShippedDefaultAgent(definition)
                    ? definition
                    : defineAgent(definition),
            );
        if (typeof normalized !== "string") {
            effectivePosture(this.runtimePosture, normalized, this.config);
        }
        return new Agent({
            definition: normalized,
            binding: options,
            workspace: options.workspace ?? this.workspace,
            profileDirectory: this.profileDirectory,
            config: this.config,
            runtimePosture: this.runtimePosture,
            createAdapter: this.createAdapter,
            readRequestOptionsConfig: this.readRequestOptionsConfig,
        });
    }
}

export class Agent {
    constructor(private readonly options: BoundAgentOptions) {}

    async run<Output = never>(
        prompt: string,
        options: AgentRunOptions<Output> = {},
    ): Promise<AgentRunResult<Output>> {
        if (prompt.trim().length === 0) {
            throw new Error("Agent prompt must not be empty");
        }
        options.signal?.throwIfAborted();

        const resolved = await resolveAgentOptions(this.options);
        const id = randomUUID();
        const durableSessionPath = options.sessionPath;
        const temporaryDirectory = durableSessionPath === undefined
            ? await mkdtemp(join(tmpdir(), "vera-sdk-"))
            : undefined;
        const sessionPath = durableSessionPath
            ?? join(temporaryDirectory!, `${id}.jsonl`);
        if (durableSessionPath !== undefined) {
            await mkdir(dirname(durableSessionPath), { recursive: true, mode: 0o700 });
        }
        // Tools resolve relative paths against the session header's cwd.
        const sessionStore = await SessionStore.create(sessionPath, {
            sessionId: id,
            cwd: resolved.workspace,
        });
        const resident = new ResidentAgent(id, resolved.workspace);
        const attachment = resident.attach();
        let text = "";
        let terminalText = "";
        let usage: SessionModelUsage | undefined;
        let outcome: AgentRunOutcome = "completed";
        let error: AgentRunError | undefined;
        const substitutions: ModelSubstitution[] = [];
        let loop: Promise<void> | undefined;
        let loopFailure: unknown;
        const abort = (): void => {
            try {
                attachment.send({ type: "abort" });
            } catch {
                // A settled turn needs no second cancellation.
            }
        };
        try {
            const configuredAdapter = resolved.createAdapter(
                resolved.config,
                resolved.workspace,
            );
            const adapter = new ProviderRoutingAdapter(
                () => configuredAdapter,
                resolved.config.provider,
                undefined,
                (request, provider) => applyModelRequestOptions(
                    request,
                    resolved.readRequestOptionsConfig(),
                    provider,
                ),
            );
            const selected = resolveAgentSnapshot(resolved.definition);
            const hooks = new ToolHooks();
            if (options.prepareTurn !== undefined) {
                hooks.registerPreTurn(options.prepareTurn);
            }
            loop = runHeadlessLoop(
                resident.engine,
                adapter,
                resolved.model,
                resolved.reasoningEffort,
                {
                    approvalMode: resolved.posture,
                    offerTools: resolved.definition.tools?.length !== 0,
                    loadOptionalContext: false,
                    instructionRoot: {
                        path: resolved.workspace,
                        source: "workspace",
                    },
                },
                {
                    readModelSettings: () => ({
                        provider: resolved.config.provider,
                        model: resolved.model,
                        ...(resolved.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: resolved.reasoningEffort }),
                    }),
                    readPolicy: () => ({
                        modelFallback: configuredModelFallback(resolved.config),
                        ...(resolved.config.permission_modes === undefined
                            ? {}
                            : {
                                permissionModes:
                                    resolved.config.permission_modes,
                            }),
                    }),
                    readSelectedAgent: () => selected,
                    ...(options.prepareTurn === undefined ? {} : { hooks }),
                    sessionStore,
                },
            ).catch((caught: unknown) => {
                loopFailure = caught;
                resident.fail(randomUUID(), errorMessage(caught));
            });
            if (options.signal?.aborted === true) {
                abort();
            } else {
                options.signal?.addEventListener("abort", abort, { once: true });
            }
            resident.sendPrompt(prompt);
            for (;;) {
                const update = await attachment.receive();
                if (update.type === "assistant_delta") {
                    text += update.text;
                    terminalText += update.text;
                    continue;
                }
                if (update.type === "tool_started") {
                    terminalText = "";
                    continue;
                }
                if (update.type === "model_substitution") {
                    substitutions.push(update);
                    continue;
                }
                if (update.type === "ui_request") {
                    refuseHeadlessUiRequest(attachment, update);
                    continue;
                }
                if (update.type === "agent_failed") {
                    outcome = "failed";
                    error = { kind: "runtime", message: update.detail };
                    break;
                }
                if (update.type !== "turn_finished") continue;
                usage = update.usage;
                if (update.outcome === "aborted") {
                    outcome = "aborted";
                    error = {
                        kind: "aborted",
                        message: update.error ?? "Agent run was aborted",
                    };
                }
                if (update.outcome === "error") {
                    outcome = "failed";
                    error = {
                        kind: "model",
                        message: update.error ?? "Model run failed",
                    };
                }
                break;
            }
        } finally {
            options.signal?.removeEventListener("abort", abort);
            attachment.detach();
            resident.close();
            try {
                await loop;
                if (
                    loopFailure !== undefined
                    && outcome !== "failed"
                    && !(loopFailure instanceof ResidentAgentClosedError)
                ) {
                    throw loopFailure;
                }
            } finally {
                if (temporaryDirectory !== undefined) {
                    await rm(temporaryDirectory, { recursive: true, force: true });
                }
            }
        }

        let output: Output | undefined;
        let hasOutput = false;
        if (outcome === "completed" && options.output !== undefined) {
            try {
                output = options.output.parse(structuredValue(terminalText));
                hasOutput = true;
            } catch (caught) {
                outcome = "failed";
                error = {
                    kind: "schema",
                    message: `Structured output failed validation: ${errorMessage(caught)}`,
                };
            }
        }

        const used = usage?.rows.at(-1);
        return {
            outcome,
            text,
            ...(hasOutput ? { output: output as Output } : {}),
            model: {
                provider: used?.provider ?? resolved.config.provider,
                model: used?.model ?? resolved.model,
            },
            ...(usage === undefined ? {} : { usage }),
            substitutions,
            ...(error === undefined ? {} : { error }),
        };
    }
}

async function resolveAgentOptions(
    options: BoundAgentOptions,
): Promise<ResolvedAgentOptions> {
    const definition = typeof options.definition === "string"
        ? await catalogDefinition(
            options.definition,
            options.workspace,
            options.profileDirectory,
            options.config,
        )
        : options.definition;
    bindableDefinition(definition);
    const posture = effectivePosture(
        options.runtimePosture,
        definition,
        options.config,
    );
    const pair = options.binding.provider === undefined
            && options.binding.model === undefined
        ? defaultPair(
            definition,
            options.workspace,
            options.profileDirectory,
        )
        : undefined;
    const provider = options.binding.provider
        ?? pair?.provider
        ?? options.config.provider;
    const model = options.binding.model
        ?? pair?.model
        ?? options.config.model;
    if (provider.length === 0 || model.length === 0) {
        throw new Error(
            `No model route: pass provider and model to the agent, or add config.json to ${options.profileDirectory}`,
        );
    }
    const selectedConfig: VeraConfig = {
        ...options.config,
        provider,
        model,
        ...(provider === options.config.provider ? {} : { fallback: undefined }),
    };
    return {
        definition,
        workspace: options.workspace,
        config: selectedConfig,
        model,
        reasoningEffort: options.binding.reasoningEffort
            ?? pair?.reasoningEffort
            ?? selectedConfig.reasoning_effort,
        posture,
        createAdapter: options.createAdapter,
        readRequestOptionsConfig: options.readRequestOptionsConfig,
    };
}

async function catalogDefinition(
    name: string,
    workspace: string,
    profileDirectory: string,
    config: VeraConfig,
): Promise<AgentDefinition> {
    const catalog = await loadAgentCatalog({
        projectRoot: workspace,
        userDirectory: join(profileDirectory, "agents"),
        permissionModes: permissionModeNames(config),
        interactive: false,
    });
    const found = findCatalogAgent(catalog, name);
    if (found === undefined) {
        throw new Error(`No agent named ${name}`);
    }
    return found.definition;
}

function defaultPair(
    definition: AgentDefinition,
    workspace: string,
    profileDirectory: string,
): ResolvedDefaultPair | undefined {
    if (definition.defaultPair === undefined) return undefined;
    const pool = loadPoolFile({
        userPath: join(profileDirectory, "pool.json"),
        projectRoot: workspace,
    }).merged;
    const id = resolvePoolRef(pool, definition.defaultPair.name);
    if (id === undefined) return undefined;
    const bound = splitModelId(id);
    if (bound === undefined) return undefined;
    return {
        provider: bound.provider,
        model: bound.model,
        ...(definition.defaultPair.effort === undefined
            ? {}
            : { reasoningEffort: definition.defaultPair.effort }),
    };
}

function bindableDefinition(definition: AgentDefinition): AgentDefinition {
    if (definition.nudges !== undefined) {
        throw new Error(
            `Agent ${definition.name} carries nudges, which an embedded run cannot show`,
        );
    }
    return definition;
}

function isShippedDefaultAgent(definition: AgentDefinition): boolean {
    return definition.name === DEFAULT_AGENT.name
        && definition.instructions === "";
}

function effectivePosture(
    runtimePosture: string,
    definition: AgentDefinition,
    config: VeraConfig,
): string {
    requirePermissionMode(runtimePosture, config);
    const requested = definition.posture ?? runtimePosture;
    requirePermissionMode(requested, config);
    if (definition.forbiddenAccess?.includes(requested) === true) {
        throw new Error(
            `Agent ${definition.name} forbids permission mode ${requested}`,
        );
    }
    if (requested === runtimePosture) return requested;
    const runtimeRank = builtInPostureRank(runtimePosture);
    const requestedRank = builtInPostureRank(requested);
    if (runtimeRank === undefined || requestedRank === undefined) {
        throw new Error(
            `Agent ${definition.name} posture ${requested} cannot be proven no wider than runtime posture ${runtimePosture}`,
        );
    }
    if (requestedRank > runtimeRank) {
        throw new Error(
            `Agent ${definition.name} posture ${requested} would widen runtime posture ${runtimePosture}`,
        );
    }
    return requested;
}

function builtInPostureRank(name: string): number | undefined {
    const rank = BUILT_IN_PERMISSION_MODE_NAMES.indexOf(name);
    return rank < 0 ? undefined : rank;
}

// Without config.json the agent names its own route, and posture stays readonly.
function homeConfig(profileDirectory: string, workspace: string): VeraConfig {
    return loadOptionalVeraConfig({
        path: join(profileDirectory, "config.json"),
        projectRoot: workspace,
    }) ?? {
        schema_version: VERA_CONFIG_SCHEMA_VERSION,
        provider: "",
        model: "",
        approval_mode: "readonly",
    };
}

function requirePermissionMode(name: string, config: VeraConfig): void {
    if (
        builtInPermissionMode(name) === undefined
        && config.permission_modes?.[name] === undefined
    ) {
        throw new Error(`No permission mode named ${name}`);
    }
}

function permissionModeNames(config: VeraConfig): readonly string[] {
    return [
        ...BUILT_IN_PERMISSION_MODE_NAMES,
        ...Object.keys(config.permission_modes ?? {}),
    ];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function structuredValue(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (exactError) {
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] !== "{" && text[index] !== "[") continue;
            try {
                return JSON.parse(text.slice(index).trim());
            } catch {
                // Keep looking for one complete JSON value at the end.
            }
        }
        throw exactError;
    }
}

function defaultAdapterFactory(): NonNullable<VeraCreateOptions["createAdapter"]> {
    const authStorage = createAuthStorage();
    return (selected, selectedWorkspace) =>
        createConfiguredModelAdapter(selected, {
            authStorage,
            projectRoot: selectedWorkspace,
        });
}

function defaultRunAdapterFactory(): NonNullable<VeraRunOptions["createAdapter"]> {
    const authStorage = readOnlyAuthStorage(createAuthStorage());
    return (selected, selectedWorkspace) =>
        createConfiguredModelAdapter(selected, {
            authStorage,
            projectRoot: selectedWorkspace,
        });
}

function readOnlyAuthStorage(inner: AuthStorage): AuthStorage {
    return {
        getCredential: (provider) => inner.getCredential(provider),
        setCredential() {
            throw new Error(
                "This bounded run cannot write auth.json. Refresh the credential with vera login, then retry.",
            );
        },
        deleteCredential() {
            throw new Error(
                "This bounded run cannot write auth.json. Refresh the credential with vera login, then retry.",
            );
        },
    };
}

function mapCredentialFailure<Output>(
    result: AgentRunResult<Output>,
): AgentRunResult<Output> {
    if (result.error === undefined || !isUnusableCredential(result.error.message)) {
        return result;
    }
    return {
        ...result,
        error: {
            ...result.error,
            message: `${result.model.provider} credential is not usable. Set its API key or run vera login, then retry.`,
        },
    };
}

function isUnusableCredential(message: string): boolean {
    const lowered = message.toLowerCase();
    return lowered.includes("expired")
        || lowered.includes("unauthorized")
        || lowered.includes("auth.json")
        || lowered.includes("credential")
        || lowered.includes("401");
}

function refuseHeadlessUiRequest(
    attachment: AgentAttachment,
    update: UiRequestUpdate,
): void {
    if (isToolApprovalUiRequestUpdate(update)) {
        attachment.send({
            type: "ui_response",
            requestId: update.requestId,
            response: { type: "tool_approval", decision: "deny" },
        });
        return;
    }
    if (isUserQuestionUiRequestUpdate(update)) {
        attachment.send({
            type: "ui_response",
            requestId: update.requestId,
            response: { type: "user_question", outcome: "cancelled" },
        });
        return;
    }
    if (isConfigurationRequiredUiRequestUpdate(update)) {
        attachment.send({
            type: "ui_response",
            requestId: update.requestId,
            response: {
                type: "configuration_required",
                outcome: "unavailable",
            },
        });
    }
}
