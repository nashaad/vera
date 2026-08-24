import { randomUUID } from "node:crypto";

import type {
    AssistantMessage,
    ModelAdapter,
    ModelReasoningEffort,
    ModelSubstitution,
} from "../model/types.ts";
import {
    defaultSessionPath,
    SessionStore,
    type SessionCreationMetadata,
} from "../store/session-store.ts";
import type { ReviewLog } from "./review-log.ts";
import { EngineEventBus } from "./events.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import {
    resolveAgentSnapshot,
    type AgentWearSnapshot,
} from "../agents/wear.ts";
import { ToolHooks } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
import type { InstructionRoot } from "./memory.ts";
import type { PromptContribution } from "./prompt-contributions.ts";
import {
    createInProcessChannel,
    type InProcessChannel,
} from "./message-channel.ts";
import type { ApprovalMode, PermissionMode } from "./permissions.ts";
import { sessionAttachmentName } from "../attachments/service.ts";
import {
    createProtocolEncoder,
    isToolApprovalUiRequestUpdate,
    type ToolApprovalUiRequestUpdate,
} from "./protocol.ts";
import { PromptPrefixTracker } from "./prompt-prefix-drift.ts";
import type { ModelFallbackPolicy } from "./recovery.ts";
import type { ModelTurnSettings } from "./model-settings.ts";
import {
    createRoutedToolReviewer,
    type ToolReviewerSettings,
} from "./reviewer.ts";
import {
    createReviewerProfileRouter,
    runTurn,
    type RunTurnState,
} from "./run-turn.ts";
import { newStashingToolRuntime } from "./preimage.ts";
import type {
    ApplyToolEffect,
    RegisteredTool,
    ToolEffectContext,
} from "../tools/types.ts";
import type { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import type { ToolRuntime } from "../tools/runtime.ts";
import type { PooledModel } from "../model/catalog-view.ts";
import {
    modelRef,
    resolveAssignedSubagentModel,
    type LadderCandidate,
    type LadderPool,
    type RelativeEffort,
} from "../model/subagent-ladder.ts";
import {
    DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    validChildAgentLimit,
} from "./agent-limits.ts";

export interface CreateSubagentEffectApplierOptions {
    readonly adapter: ModelAdapter;
    readonly workspace: string;
    /** Durable identity of the session that owns spawned children. */
    readonly parentSessionId?: string;
    /**
     * The parent's instruction root, handed down so a child keys project
     * memory where its parent does. Absent falls back to the workspace.
     */
    readonly instructionRoot?: InstructionRoot;
    /** Shared with children: one session, one scratch space. */
    readonly scratchDir?: string;
    readonly processRegistry?: ManagedProcessRegistry;
    readonly disabledPromptContributions?: readonly string[];
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionPathForId?: (sessionId: string) => string;
    readonly relayToolApproval?: ChildToolApprovalRelay;
    readonly maxConcurrentChildren?: number;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
    ) => Promise<readonly PromptContribution[]>;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    readonly sessionMetadata?: SessionCreationMetadata;
    /** Makes the spawn tools' model override resolvable; absent, it is refused. */
    readonly readPool?: () => readonly PooledModel[];
    /** What a spawn with no model override runs on; absent, the parent model. */
    readonly subagentModel?: SpawnModelDefault;
    /** Allow/deny, the failsafe list and families; absent, nothing is gated. */
    readonly readPolicy?: () => SubagentPoolPolicy;
    /** Host-owned, coalesced configuration + confirmation for an empty policy. */
    readonly requestMissingConfiguration?: RequestMissingSubagentConfiguration;
    /**
     * The same reviewer settings the parent runs under. Settings, not the
     * parent's reviewer instance: a reviewer keeps a running conversation
     * about one transcript, and each child has its own.
     */
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /**
     * Resolves an agent a spawn named. Absent means this host has no agents,
     * and a spawn that names one is refused rather than run without it.
     */
    readonly loadAgent?: (
        name: string,
    ) => Promise<AgentDefinition | undefined>;
}

export interface SpawnModelDefault {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface MissingSubagentConfigurationRequest {
    readonly description: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly agentDefault?: SpawnModelDefault;
}

export type RequestMissingSubagentConfiguration = (
    request: MissingSubagentConfigurationRequest,
    context: ToolEffectContext,
    signal: AbortSignal,
) => Promise<SpawnModelResolution>;

export type SpawnModelResolution =
    | {
        readonly ok: true;
        readonly provider?: string;
        readonly model: string;
        readonly reasoningEffort?: ModelReasoningEffort;
        /** A transcript line about a request that fell through the pool. */
        readonly notice?: string;
        /** The same substitutions the notice reads out, as typed rows. */
        readonly substitutions?: readonly ModelSubstitution[];
    }
    | {
        readonly ok: false;
        readonly reason:
            | "configuration_required"
            | "not_permitted"
            | "unavailable"
            | "cancelled";
        readonly error: string;
    };

/**
 * The policy fields of the pool file that only the ladder reads.
 *
 * SEAM: the pool file loader owns parsing and validation and hands this
 * shape over; nothing here opens a file. `families` maps `provider/model`
 * to the declared family label used to bound sibling search.
 */
export interface SubagentPoolPolicy {
    /** Ordered, shortlist-admitted authorization boundary. */
    readonly assigned?: readonly SpawnModelDefault[];
    /** Appends the exact parent provider/model as the final candidate. */
    readonly allowSelf?: boolean;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    /** Verified pool entries in file order, the failsafe rung's candidates. */
    readonly failsafe?: readonly string[];
    readonly families?: Readonly<Record<string, string>>;
    /**
     * Resolved tool-call support per `provider/model`, for the models the
     * pool failsafe may reach. A model missing from this map is not known
     * to call tools, which is why the map is not a set of the ones that do.
     */
    readonly tools?: Readonly<Record<string, boolean>>;
    /** `defaults.subagentEffort`, applied to the self rung. */
    readonly selfEffort?: RelativeEffort;
    /**
     * `defaults.subagent`: the model the default rung tries, or `"self"`.
     * It wins over the host's own configured default, because the pool file
     * is where the user states this and the host config is the older answer.
     */
    readonly subagentDefault?: string;
}

export function subagentModelBoundary(
    policy: SubagentPoolPolicy | undefined,
    context: Pick<
        ToolEffectContext,
        "provider" | "model" | "reasoningEffort"
    >,
): readonly ModelTurnSettings[] {
    const provider = context.provider ?? "";
    const models: ModelTurnSettings[] = (policy?.assigned ?? []).map((entry) => ({
        ...((entry.provider ?? provider) === ""
            ? {}
            : { provider: entry.provider ?? provider }),
        model: entry.model,
        ...(entry.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: entry.reasoningEffort }),
    }));
    if (policy?.allowSelf === true) {
        models.push({
            ...(provider === "" ? {} : { provider }),
            model: context.model,
            ...(context.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: context.reasoningEffort }),
        });
    }
    const seen = new Set<string>();
    return models.filter((entry) => {
        const ref = modelRef(entry.provider ?? "", entry.model);
        if (seen.has(ref)) return false;
        seen.add(ref);
        return true;
    });
}

/**
 * Turns a spawn tool's optional model suggestion into runnable settings.
 *
 * The suggestion is a suggestion, never a contract: a model that cannot run
 * falls through the ladder in `subagent-ladder.ts` rather than failing the
 * spawn, because nobody is watching a subagent to retry it. Every
 * substitution the ladder makes comes back as a notice, which the caller
 * prefixes to the child's result.
 */
export function resolveSpawnModelChoice(
    effect: { readonly model?: string; readonly reasoningEffort?: string },
    context: ToolEffectContext,
    readPool?: () => readonly PooledModel[],
    subagentModel?: SpawnModelDefault,
    policy?: SubagentPoolPolicy,
    agentDefault?: SpawnModelDefault,
): SpawnModelResolution {
    const sessionProvider = context.provider ?? "";
    const pool = readPool?.() ?? [];
    const suggested = effect.model === undefined
        ? undefined
        : poolNamed(effect.model, pool) ?? effect.model;
    const configuredDefault = agentDefault === undefined
        ? policy?.subagentDefault
            ?? (subagentModel === undefined
            ? undefined
            : modelRef(
                subagentModel.provider ?? sessionProvider,
                subagentModel.model,
            ))
        : modelRef(
            agentDefault.provider ?? sessionProvider,
            agentDefault.model,
        );
    const assigned = policy?.assigned ?? [];
    if (assigned.length === 0 && policy?.allowSelf !== true) {
        return {
            ok: false,
            reason: "configuration_required",
            error: "No subagent models are configured. Choose models in Defaults -> Subagents.",
        };
    }
    const outcome = resolveAssignedSubagentModel(
        {
            ...(suggested === undefined ? {} : { requested: suggested }),
            ...(effect.reasoningEffort === undefined
                ? {}
                : { requestedEffort: effect.reasoningEffort }),
            ...(configuredDefault === undefined ? {} : {
                preferred: configuredDefault,
            }),
            ...(agentDefault?.reasoningEffort === undefined
                    && (agentDefault !== undefined
                        || subagentModel?.reasoningEffort === undefined)
                ? {}
                : {
                    preferredEffort: agentDefault?.reasoningEffort
                        ?? subagentModel?.reasoningEffort,
                }),
            assigned: assigned.map((entry) => ({
                provider: entry.provider ?? sessionProvider,
                model: entry.model,
                ...(entry.reasoningEffort === undefined
                    ? {}
                    : { effort: entry.reasoningEffort }),
            })),
            allowSelf: policy?.allowSelf === true,
            sessionProvider,
            sessionModel: context.model,
            ...(context.reasoningEffort === undefined
                ? {}
                : { sessionEffort: context.reasoningEffort }),
            ...(policy?.selfEffort === undefined
                ? {}
                : { selfEffort: policy.selfEffort }),
        },
        ladderPool(context, pool, policy),
    );
    if (!outcome.ok) {
        return {
            ok: false,
            reason: outcome.reason,
            error: outcome.error,
        };
    }
    return {
        ok: true,
        ...(outcome.provider === "" ? {} : { provider: outcome.provider }),
        model: outcome.model,
        ...(outcome.effort === undefined
            ? {}
            : { reasoningEffort: outcome.effort }),
        ...(outcome.notice === undefined ? {} : { notice: outcome.notice }),
        ...(outcome.substitutions.length === 0
            ? {}
            : { substitutions: outcome.substitutions }),
    };
}

/**
 * Projects the runtime pool into the ladder's view, plus the two models that
 * are runnable without being pooled: the session's own model, which is
 * running right now by definition, and the configured subagent default,
 * which the user declared by hand.
 */
function ladderPool(
    context: ToolEffectContext,
    pool: readonly PooledModel[],
    policy: SubagentPoolPolicy | undefined,
): LadderPool {
    const families = policy?.families ?? {};
    const tools = policy?.tools ?? {};
    const models: LadderCandidate[] = pool.map((entry) => {
            const ref = modelRef(entry.provider, entry.model);
            return {
                provider: entry.provider,
                model: entry.model,
                ...(families[ref] === undefined
                    ? {}
                    : { family: families[ref] }),
                ...(tools[ref] === undefined ? {} : { tools: tools[ref] }),
                available: entry.available,
                levels: entry.levels.map((level) => level.id),
                ...(entry.defaultLevel === undefined
                    ? {}
                    : { defaultLevel: entry.defaultLevel }),
            };
        });
    const sessionProvider = context.provider ?? "";
    const declared: readonly {
        provider: string;
        model: string;
        effort?: string;
    }[] = [
        {
            provider: sessionProvider,
            model: context.model,
            ...(context.reasoningEffort === undefined
                ? {}
                : { effort: context.reasoningEffort }),
        },
    ];
    for (const entry of declared) {
        const ref = modelRef(entry.provider, entry.model);
        if (models.some((known) => modelRef(known.provider, known.model) === ref)) {
            continue;
        }
        // No `levels`: nothing here knows this model's ladder. A synthesized
        // one-element list would make every other level look unsupported and
        // report a substitution the user never had done to them.
        models.push({
            provider: entry.provider,
            model: entry.model,
            ...(families[ref] === undefined ? {} : { family: families[ref] }),
            ...(tools[ref] === undefined ? {} : { tools: tools[ref] }),
            available: true,
            ...(entry.effort === undefined
                ? {}
                : { defaultLevel: entry.effort }),
        });
    }
    return {
        models,
        ...(policy?.allow === undefined ? {} : { allow: policy.allow }),
        ...(policy?.deny === undefined ? {} : { deny: policy.deny }),
        ...(policy?.failsafe === undefined
            ? {}
            : { failsafe: policy.failsafe }),
    };
}

/**
 * The `provider/model` a pool name stands for. A ref with a slash is already
 * an id, and an unmatched ref is left alone so the ladder reports it as the
 * user wrote it.
 */
function poolNamed(
    ref: string,
    pool: readonly PooledModel[],
): string | undefined {
    if (ref.includes("/")) {
        return undefined;
    }
    const entry = pool.find((candidate) => candidate.poolName === ref);
    return entry === undefined
        ? undefined
        : `${entry.provider}/${entry.model}`;
}

/**
 * Splits `provider/model` at the first separator only: an aggregator model id
 * carries its own slashes, so `openrouter/deepseek/deepseek-chat` is one model
 * on one provider. A bare name belongs to the session's provider.
 */
export interface RunSubagentOptions {
    readonly adapter: ModelAdapter;
    readonly provider?: string;
    readonly model: string;
    readonly description: string;
    readonly workspace: string;
    readonly parentSessionId?: string;
    /** Inherited from the parent. Absent falls back to the workspace. */
    readonly instructionRoot?: InstructionRoot;
    readonly scratchDir?: string;
    readonly processRegistry?: ManagedProcessRegistry;
    readonly disabledPromptContributions?: readonly string[];
    readonly approvalMode: ApprovalMode;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly modelFallback?: ModelFallbackPolicy;
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly signal?: AbortSignal;
    readonly relayToolApproval?: ChildToolApprovalRelay;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
    ) => Promise<readonly PromptContribution[]>;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    readonly sessionMetadata?: SessionCreationMetadata;
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    /**
     * The agent this child wears, already intersected with what the parent
     * could reach. Delegation never widens: a tool the agent grants but the
     * parent does not have is not in this list.
     */
    readonly agentWear?: AgentWearSnapshot;
    /** The parent's mode, which clamps every action the child takes. */
    readonly clampPermissionMode?: ApprovalMode;
}

export type ChildToolApprovalRelay = (
    update: ToolApprovalUiRequestUpdate,
    sourceAgentId: string,
    sourceTask: string,
    signal: AbortSignal,
) => Promise<"allow_once" | "deny">;

export interface SubagentResult {
    readonly text: string;
    readonly isError: boolean;
    readonly sessionId: string;
    readonly sessionPath: string;
}

export function createSubagentEffectApplier(
    options: CreateSubagentEffectApplierOptions,
): ApplyToolEffect {
    const maxConcurrentChildren = validChildAgentLimit(
        options.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILD_AGENTS,
    );
    let activeChildren = 0;
    return async (effect, signal, context) => {
        if (effect.type !== "spawn_subagent") {
            throw new Error(`Unsupported subagent effect: ${effect.type}`);
        }
        if (activeChildren >= maxConcurrentChildren) {
            return {
                kind: "output",
                output:
                    `Subagent limit reached (${maxConcurrentChildren} running).`,
                isError: true,
            };
        }
        // The agent's own default pair is the fallback between the explicit
        // arguments and the ladder: it is a default, so it loses to what the
        // caller asked for and beats what nobody asked for.
        let wear: AgentWearSnapshot | undefined;
        let agentDefault: SpawnModelDefault | undefined;
        if (effect.agent !== undefined) {
            if (options.loadAgent === undefined) {
                return {
                    kind: "output",
                    output: "This host does not support agents.",
                    isError: true,
                };
            }
            const definition = await options.loadAgent(effect.agent);
            if (definition === undefined) {
                return {
                    kind: "output",
                    output: `No agent named ${effect.agent}`,
                    isError: true,
                };
            }
            if (definition.nudges !== undefined) {
                // A spawn has no surface to show one on, so carrying nudges
                // here is a validation error rather than a silent no-op.
                return {
                    kind: "output",
                    output:
                        `Agent ${definition.name} carries nudges, which a subagent cannot show.`,
                    isError: true,
                };
            }
            wear = narrowAgainstParent(
                resolveAgentSnapshot(definition),
                context.agentWear,
            );
            if (
                effect.model === undefined
                && definition.defaultPair !== undefined
            ) {
                const named = poolNamed(
                    definition.defaultPair.name,
                    options.readPool?.() ?? [],
                );
                if (named !== undefined) {
                    const separator = named.indexOf("/");
                    agentDefault = {
                        provider: named.slice(0, separator),
                        model: named.slice(separator + 1),
                        ...(definition.defaultPair.effort === undefined
                            ? {}
                            : {
                                reasoningEffort: definition.defaultPair
                                    .effort as ModelReasoningEffort,
                            }),
                    };
                }
            }
        }
        let policy = options.readPolicy?.();
        let resolved = resolveSpawnModelChoice(
            effect,
            context,
            options.readPool,
            options.subagentModel,
            policy,
            agentDefault,
        );
        if (
            !resolved.ok
            && resolved.reason === "configuration_required"
            && options.requestMissingConfiguration !== undefined
        ) {
            resolved = await options.requestMissingConfiguration({
                description: effect.description,
                ...(effect.model === undefined ? {} : { model: effect.model }),
                ...(effect.reasoningEffort === undefined ? {} : {
                    reasoningEffort: effect.reasoningEffort,
                }),
                ...(agentDefault === undefined ? {} : { agentDefault }),
            }, context, signal);
            policy = options.readPolicy?.();
        }
        if (!resolved.ok) {
            return { kind: "output", output: resolved.error, isError: true };
        }
        // Configuration may have kept several calls waiting while no child
        // counted as active. Re-check at the admission boundary so they cannot
        // all pass the earlier snapshot and exceed the limit together.
        if (activeChildren >= maxConcurrentChildren) {
            return {
                kind: "output",
                output:
                    `Subagent limit reached (${maxConcurrentChildren} running).`,
                isError: true,
            };
        }
        const notice = resolved.notice;
        const substitutions = resolved.substitutions ?? [];
        activeChildren += 1;
        const sessionId = randomUUID();
        // Read once here. These come from the host and can change while the
        // session runs, so a child gets one coherent set of settings rather
        // than one field from before an edit and the next from after it.
        const {
            disabledPromptContributions,
            reviewer,
            reviewers,
            permissionModes,
        } = options;
        const parentSessionId = context.sessionId ?? options.parentSessionId;
        try {
            const result = await runSubagent({
                adapter: options.adapter,
                ...(resolved.provider === undefined
                    ? {}
                    : { provider: resolved.provider }),
                model: resolved.model,
                description: effect.description,
                workspace: options.workspace,
                ...(options.instructionRoot === undefined
                    ? {}
                    : { instructionRoot: options.instructionRoot }),
                ...(options.scratchDir === undefined
                    ? {}
                    : { scratchDir: options.scratchDir }),
                ...(options.processRegistry === undefined
                    ? {}
                    : { processRegistry: options.processRegistry }),
                ...(disabledPromptContributions === undefined ? {} : {
                    disabledPromptContributions,
                }),
                approvalMode: context.approvalMode,
                extensionTools: options.extensionTools,
                ...(options.loadContextualContributions === undefined ? {} : {
                    loadContextualContributions:
                        options.loadContextualContributions,
                }),
                offerTools: options.offerTools,
                loadOptionalContext: options.loadOptionalContext,
                sessionMetadata: parentSessionId === undefined
                    ? options.sessionMetadata
                    : {
                        ...options.sessionMetadata,
                        parentId: parentSessionId,
                        delegation: {
                            kind: "subagent",
                            parentId: parentSessionId,
                            models: subagentModelBoundary(policy, context),
                        },
                    },
                parentSessionId,
                signal,
                sessionId,
                ...(options.relayToolApproval === undefined
                    ? {}
                    : { relayToolApproval: options.relayToolApproval }),
                ...(resolved.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: resolved.reasoningEffort }),
                // A generic fallback can name a model outside the persisted
                // delegation boundary. Provider retry of this exact model is
                // still handled by recovery; cross-model fallback is not.
                ...(options.sessionPathForId === undefined
                    ? {}
                    : { sessionPath: options.sessionPathForId(sessionId) }),
                ...(reviewer === undefined ? {} : { reviewer }),
                ...(reviewers === undefined ? {} : { reviewers }),
                ...(options.reviewLog === undefined
                    ? {}
                    : { reviewLog: options.reviewLog }),
                ...(options.readReviewer === undefined
                    ? {}
                    : { readReviewer: options.readReviewer }),
                ...(permissionModes === undefined ? {} : { permissionModes }),
                ...(wear === undefined ? {} : { agentWear: wear }),
                // The parent's mode clamps every action the child takes, per
                // action. Delegation narrows; it never widens.
                clampPermissionMode: context.approvalMode,
            });
            return {
                kind: "output",
                output: notice === undefined
                    ? result.text
                    : `${notice}\n\n${result.text}`,
                isError: result.isError,
                ...(substitutions.length === 0 ? {} : { substitutions }),
            };
        } finally {
            activeChildren -= 1;
        }
    };
}

export async function runSubagent(
    options: RunSubagentOptions,
): Promise<SubagentResult> {
    const channel = createInProcessChannel();
    const childSignal = options.signal ?? new AbortController().signal;
    const onAbort = (): void => channel.client.send({ type: "abort" });
    let toolRuntime: ToolRuntime | undefined;
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
        options.signal?.throwIfAborted();
        const sessionId = options.sessionId ?? randomUUID();
        const store = await SessionStore.create(
            options.sessionPath ?? defaultSessionPath(sessionId),
            {
                sessionId,
                cwd: options.workspace,
                ...(options.parentSessionId === undefined
                    ? {}
                    : { parentId: options.parentSessionId }),
                ...options.sessionMetadata,
            },
        );
        options.signal?.throwIfAborted();
        await store.appendApprovalMode(options.approvalMode);
        options.signal?.throwIfAborted();
        await store.appendModelSettings({
            ...(options.provider === undefined ? {} : { provider: options.provider }),
            model: options.model,
            ...(options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
        });
        options.signal?.throwIfAborted();
        const events = new EngineEventBus();
        const protocol = createProtocolEncoder(
            channel.engine,
            sessionAttachmentName(store),
        );
        events.subscribe(protocol);
        const instructionRoot: InstructionRoot = options.instructionRoot
            ?? { path: options.workspace, source: "workspace" };
        // The child builds its own reviewer instances rather than borrowing
        // the parent's: a reviewer keeps a running conversation about one
        // transcript, and interleaving two transcripts would read as a rewind
        // on every review. Without configured settings the reviewer runs on
        // the child's own model, mirroring the parent's fallback. Leaving it
        // unwired is not an option in `auto`: every non-routine action would
        // fall back to a human approval prompt, or a denial when nobody is
        // attached, which quietly turns the child's auto mode into ask.
        const reviewToolCall = createRoutedToolReviewer(
            options.adapter,
            {
                ...(options.readReviewer?.() ?? options.reviewer ?? {
                    models: [{
                        model: options.model,
                        ...(options.provider === undefined
                            ? {}
                            : { provider: options.provider }),
                        ...(options.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: options.reasoningEffort }),
                    }],
                }),
                ...(options.reviewLog === undefined
                    ? {}
                    : { log: options.reviewLog }),
            },
        );
        toolRuntime = newStashingToolRuntime(
            options.workspace,
            sessionId,
            undefined,
            instructionRoot.path,
            options.processRegistry,
            true,
        );
        const state: RunTurnState = {
            messages: [],
            store,
            toolRuntime,
            instructionRoot,
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode: options.approvalMode,
            ...(options.agentWear === undefined ? {} : {
                readAgentWear: () => options.agentWear,
            }),
            ...(options.clampPermissionMode === undefined
                ? {}
                : { clampPermissionMode: options.clampPermissionMode }),
            firedNudges: new Set<string>(),
            extensionTools: options.extensionTools,
            ...(options.loadContextualContributions === undefined ? {} : {
                loadContextualContributions:
                    options.loadContextualContributions,
            }),
            offerTools: options.offerTools ?? true,
            loadOptionalContext: options.loadOptionalContext ?? true,
            reviewToolCall,
            reviewToolCallForProfile: createReviewerProfileRouter(
                reviewToolCall,
                options.adapter,
                () => options.reviewers,
                options.reviewLog,
            ),
            ...(options.permissionModes === undefined
                ? {}
                : { permissionModes: options.permissionModes }),
            promptPrefixTracker: new PromptPrefixTracker(),
            ...(options.scratchDir === undefined
                ? {}
                : { scratchDir: options.scratchDir }),
            ...(options.disabledPromptContributions === undefined ? {} : {
                disabledPromptContributions:
                    options.disabledPromptContributions,
            }),
            ...(options.modelFallback === undefined
                ? {}
                : { modelFallback: options.modelFallback }),
        };
        protocol.checkpoint(state.messages, store.activeMessageIds());
        channel.client.send({
            type: "prompt",
            content: options.description,
        });
        const updates = drainChildUpdates(
            channel.client,
            sessionId,
            options.description,
            childSignal,
            options.relayToolApproval,
        );
        const finalMessage = await runTurn(
            options.adapter,
            options.model,
            {
                ...state,
                readModelSettings: () => ({
                    ...(options.provider === undefined ? {} : { provider: options.provider }),
                    model: options.model,
                    ...(options.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: options.reasoningEffort }),
                }),
            },
            options.reasoningEffort,
        );
        await updates;
        options.signal?.throwIfAborted();
        return {
            text: finalText(finalMessage),
            isError: finalMessage.stopReason !== "stop",
            sessionId,
            sessionPath: store.path,
        };
    } finally {
        await toolRuntime?.close();
        options.signal?.removeEventListener("abort", onAbort);
    }
}

async function drainChildUpdates(
    client: InProcessChannel["client"],
    sourceAgentId: string,
    sourceTask: string,
    signal: AbortSignal,
    relayToolApproval?: ChildToolApprovalRelay,
): Promise<void> {
    while (true) {
        const update = await client.receive();
        if (update.type === "ui_request") {
            const decision = isToolApprovalUiRequestUpdate(update)
                && relayToolApproval !== undefined
                ? await relayToolApproval(
                    update,
                    sourceAgentId,
                    sourceTask,
                    signal,
                )
                : "deny";
            client.send({
                type: "ui_response",
                requestId: update.requestId,
                response: update.request.type === "tool_approval"
                    ? { type: "tool_approval", decision }
                    : { type: "user_question", outcome: "cancelled" },
            });
        }
        if (update.type === "turn_finished") {
            return;
        }
    }
}

function finalText(message: AssistantMessage): string {
    const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    if (message.stopReason === "stop") {
        return text || "Subagent finished without a text summary.";
    }
    const error = message.errorMessage?.trim() ?? "";
    return [text, error].filter((value) => value.length > 0).join("\n")
        || `Subagent stopped with ${message.stopReason}.`;
}

/**
 * The child's lists, narrowed by the parent's.
 *
 * An agent that grants a tool the parent does not have does not hand it over:
 * the child's scope is the intersection, and an absent list on either side
 * means "everything that side can reach", not "everything".
 */
export function narrowAgainstParent(
    child: AgentWearSnapshot,
    parent: AgentWearSnapshot | undefined,
): AgentWearSnapshot {
    return {
        ...child,
        ...narrowList("tools", child.tools, parent?.tools),
        ...narrowList("skills", child.skills, parent?.skills),
    };
}

function narrowList(
    key: "tools" | "skills",
    child: readonly string[] | undefined,
    parent: readonly string[] | undefined,
): Record<string, readonly string[]> {
    if (child === undefined && parent === undefined) return {};
    if (child === undefined) return { [key]: [...parent!] };
    if (parent === undefined) return { [key]: [...child] };
    return { [key]: child.filter((name) => parent.includes(name)) };
}
