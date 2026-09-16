import { randomUUID } from "node:crypto";
import { subagentAssignmentPolicy } from "./subagent-assignment.ts";
import { formatSubagentResult, type SubagentExecution } from "../tools/subagent-result.ts";

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
    type AgentSnapshot,
} from "../agents/snapshot.ts";
import { ToolHooks } from "./hooks.ts";
import { InboundCommandRouter } from "./inbound-command-router.ts";
import type { InstructionRoot } from "./memory.ts";
import type {
    ContextualContributionContext,
    PromptContribution,
} from "./prompt-contributions.ts";
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
    readonly parentSessionId?: string;
    readonly instructionRoot?: InstructionRoot;
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
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
    ) => Promise<readonly PromptContribution[]>;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    readonly sessionMetadata?: SessionCreationMetadata;
    readonly readPool?: () => readonly PooledModel[];
    readonly subagentModel?: SpawnModelDefault;
    readonly readPolicy?: () => SubagentPoolPolicy;
    readonly requestMissingConfiguration?: RequestMissingSubagentConfiguration;
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
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
        readonly notice?: string;
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

export interface SubagentPoolPolicy {
    readonly candidates?: readonly PooledModel[];
    readonly assigned?: readonly SpawnModelDefault[];
    readonly assignments?: Readonly<Record<string, readonly SpawnModelDefault[]>>;
    readonly allowSelf?: boolean;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly failsafe?: readonly string[];
    readonly families?: Readonly<Record<string, string>>;
    readonly tools?: Readonly<Record<string, boolean>>;
    readonly selfEffort?: RelativeEffort;
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
        ladderPool(context, policy?.candidates ?? pool, policy),
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

export interface RunSubagentOptions {
    readonly adapter: ModelAdapter;
    readonly provider?: string;
    readonly model: string;
    readonly description: string;
    readonly workspace: string;
    readonly parentSessionId?: string;
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
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
    ) => Promise<readonly PromptContribution[]>;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    readonly sessionMetadata?: SessionCreationMetadata;
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly reviewLog?: ReviewLog;
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    readonly selectedAgent?: AgentSnapshot;
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
    readonly execution?: SubagentExecution;
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
        let selected: AgentSnapshot | undefined;
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
                return {
                    kind: "output",
                    output:
                        `Agent ${definition.name} carries nudges, which a subagent cannot show.`,
                    isError: true,
                };
            }
            selected = narrowAgainstParent(
                resolveAgentSnapshot(definition),
                context.selectedAgent,
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
        const assignment = selected?.subagentAssignment;
        let policy = subagentAssignmentPolicy(options.readPolicy?.(), assignment);
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
            && assignment === undefined
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
            return {
                kind: "output",
                output: assignment === undefined
                    ? resolved.error
                    : `Cannot start ${selected!.name} on Defaults -> ${assignment}: ${
                        resolved.reason === "configuration_required"
                            ? "no selectable models are assigned. Configure this assignment in /defaults."
                            : resolved.error
                    }`,
                isError: true,
            };
        }
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
                ...(selected === undefined ? {} : { selectedAgent: selected }),
                clampPermissionMode: context.approvalMode,
            });
            const output = formatSubagentResult(result.text, result.execution);
            return {
                kind: "output",
                output: notice === undefined
                    ? output
                    : `${notice}\n\n${output}`,
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
        if (options.selectedAgent !== undefined) {
            await store.appendSelectedAgent(
                options.selectedAgent.name,
                options.selectedAgent,
            );
        }
        options.signal?.throwIfAborted();
        const events = new EngineEventBus();
        const protocol = createProtocolEncoder(
            channel.engine,
            sessionAttachmentName(store),
            undefined,
            undefined,
            () => store.usageMessages(),
        );
        events.subscribe(protocol);
        const instructionRoot: InstructionRoot = options.instructionRoot
            ?? { path: options.workspace, source: "workspace" };
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
            sessionId,
            messages: [],
            store,
            toolRuntime,
            instructionRoot,
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode: options.approvalMode,
            ...(options.selectedAgent === undefined ? {} : {
                readSelectedAgent: () => options.selectedAgent,
            }),
            ...(options.clampPermissionMode === undefined
                ? {}
                : { clampPermissionMode: options.clampPermissionMode }),
            firedNudges: new Set<string>(),
            injectedContextRoutePaths: new Set<string>(),
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
        let execution: SubagentExecution | undefined;
        const adapter: ModelAdapter = {
            get supportsImageInput() { return options.adapter.supportsImageInput; },
            ...(options.adapter.imageInputSupport === undefined ? {} : {
                imageInputSupport: options.adapter.imageInputSupport.bind(options.adapter),
            }),
            ...(options.adapter.supportsImageInputFor === undefined ? {} : {
                supportsImageInputFor: options.adapter.supportsImageInputFor.bind(options.adapter),
            }),
            stream(request) {
                execution = {
                    ...(options.selectedAgent === undefined ? {} : {
                        agent: options.selectedAgent.name,
                    }),
                    ...(request.provider === undefined ? {} : { provider: request.provider }),
                    model: request.model,
                    ...(request.reasoningEffort === undefined ? {} : {
                        reasoningEffort: request.reasoningEffort,
                    }),
                };
                return options.adapter.stream(request);
            },
        };
        const finalMessage = await runTurn(
            adapter,
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
            ...(execution === undefined ? {} : { execution }),
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

export function narrowAgainstParent(
    child: AgentSnapshot,
    parent: AgentSnapshot | undefined,
): AgentSnapshot {
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
