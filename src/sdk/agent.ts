import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    defineAgent,
    type AgentDefinition,
} from "../agents/definition.ts";
import {
    findCatalogAgent,
    loadAgentCatalog,
} from "../agents/catalog.ts";
import { resolveAgentSnapshot } from "../agents/wear.ts";
import {
    configuredModelFallback,
    loadVeraConfig,
    type VeraConfig,
} from "../config.ts";
import {
    BUILT_IN_PERMISSION_MODE_NAMES,
    builtInPermissionMode,
} from "../engine/permissions.ts";
import type { SessionModelUsage } from "../engine/protocol.ts";
import { runHeadlessLoop } from "../engine/run-turn.ts";
import {
    ResidentAgent,
    ResidentAgentClosedError,
} from "../host/resident-agent.ts";
import { loadPoolFile } from "../model/pool-file-loader.ts";
import { resolvePoolRef } from "../model/pool-names.ts";
import type {
    ModelAdapter,
    ModelReasoningEffort,
    ModelSubstitution,
} from "../model/types.ts";
import {
    VERA_PROFILE_ENV,
    veraProfileDirectory,
} from "../profile-paths.ts";
import { createAuthStorage } from "../providers/auth-storage.ts";
import { createConfiguredModelAdapter } from "../providers/configured.ts";

export interface VeraCreateOptions {
    /** Profile to read without changing the process-wide VERA_PROFILE value. */
    readonly profile?: string;
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
}

interface ResolvedAgentOptions {
    readonly definition: AgentDefinition;
    readonly workspace: string;
    readonly config: VeraConfig;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly posture: string;
    readonly createAdapter: (config: VeraConfig, workspace: string) => ModelAdapter;
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
    ) {}

    static async create(options: VeraCreateOptions = {}): Promise<Vera> {
        const workspace = options.workspace ?? process.cwd();
        const profileDirectory = selectedProfileDirectory(options.profile);
        const config = options.config ?? loadVeraConfig({
            path: join(profileDirectory, "config.json"),
            projectRoot: workspace,
        });
        const runtimePosture = options.posture ?? config.approval_mode;
        requirePermissionMode(runtimePosture, config);
        return new Vera(
            config,
            workspace,
            profileDirectory,
            runtimePosture,
            options.createAdapter ?? defaultAdapterFactory(),
        );
    }

    agent(
        definition: AgentDefinition | string,
        options: VeraAgentOptions = {},
    ): Agent {
        const normalized = typeof definition === "string"
            ? definition
            : bindableDefinition(defineAgent(definition));
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
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "vera-sdk-"));
        const id = randomUUID();
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
            const adapter = resolved.createAdapter(
                resolved.config,
                resolved.workspace,
            );
            const wear = resolveAgentSnapshot(resolved.definition);
            loop = runHeadlessLoop(
                resident.engine,
                adapter,
                resolved.model,
                resolved.reasoningEffort,
                {
                    sessionPath: join(temporaryDirectory, `${id}.jsonl`),
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
                    readAgentWear: () => wear,
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
                await rm(temporaryDirectory, { recursive: true, force: true });
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
    const separator = id.indexOf("/");
    if (separator < 1 || separator === id.length - 1) return undefined;
    return {
        provider: id.slice(0, separator),
        model: id.slice(separator + 1),
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

function selectedProfileDirectory(profile: string | undefined): string {
    if (profile === undefined) return veraProfileDirectory();
    return veraProfileDirectory({
        ...process.env,
        [VERA_PROFILE_ENV]: profile,
    });
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
