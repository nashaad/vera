/**
 * The two halves of what `runHeadlessLoop` needs from its owner.
 *
 * `RunHeadlessLoopData` is plain JSON: values that survive a serialize and a
 * parse with no loss. `RunHeadlessLoopServices` is everything else, meaning
 * every live object and every callback the loop reaches the host through.
 *
 * The split exists so the services half can become a wire protocol. Each
 * member below is either already expressible as a JSON request with a JSON
 * reply, or carries a note naming the JSON form it would take. Two shapes have
 * no JSON equivalent on their own and are named where they appear:
 *
 * - An `AbortSignal` argument becomes a call id on the request plus a separate
 *   `cancel { callId }` notification travelling the other way.
 * - A progress callback becomes a stream of `progress { callId, step }`
 *   notifications from callee to caller, ending at the reply.
 */

import type { AgentWearSnapshot } from "../agents/wear.ts";
import type { EffortPool } from "../model/effort-pool.ts";
import type { ModelFailureLedger } from "../store/model-failures.ts";
import type {
    SessionSettingOrigin,
    SessionStore,
} from "../store/session-store.ts";
import type {
    ApplyCommittedToolEffect,
    ApplyToolEffect,
    RegisteredTool,
    ToolEffect,
} from "../tools/types.ts";
import type { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import type { EngineEventBus, PoolAdmissionVerdict } from "./events.ts";
import type { ToolHooks } from "./hooks.ts";
import type {
    InboundCommandRouter,
    InboundCommandRouterOptions,
    SessionModelSettingsResult,
} from "./inbound-command-router.ts";
import type { InstructionRoot } from "./memory.ts";
import type { ModelSettingsPatch, ModelTurnSettings } from "./model-settings.ts";
import type {
    ApprovalMode,
    PermissionMode,
    PermissionPredicate,
    PermissionPreference,
} from "./permissions.ts";
import type {
    ContextualContributionContext,
    PromptContribution,
} from "./prompt-contributions.ts";
import type { ModelFallbackPolicy } from "./recovery.ts";
import type { ReviewLog } from "./review-log.ts";
import type { ReviewToolCall, ToolReviewerSettings } from "./reviewer.ts";
import type { SessionNameReplyUpdate, TimelineReplyUpdate } from "./protocol.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";
import type {
    RequestMissingSubagentConfiguration,
    SubagentPoolPolicy,
} from "./subagent.ts";

/**
 * Session policy the owner may change while the loop runs, so it is read at
 * each use rather than captured at start. One coarse read rather than five
 * fine-grained ones, because a wire boundary charges per round trip.
 *
 * JSON form: request `policy.read` with an empty body, reply is this object.
 * A host that would rather push sends `policy.changed` with this object and
 * the loop answers from its last copy.
 */
export interface LoopPolicy {
    readonly modelFallback?: ModelFallbackPolicy;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly disabledPromptContributions?: readonly string[];
    readonly subagentPolicy?: SubagentPoolPolicy;
}

/** Plain JSON. Fixed for the life of one loop. */
export interface RunHeadlessLoopData {
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly eventLogPath?: string;
    readonly approvalMode?: ApprovalMode;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    /**
     * Variables layered over the inherited environment in the shells this
     * session's tools spawn. The owner chooses the variables; the engine
     * passes them through opaquely.
     */
    readonly toolEnv?: Readonly<Record<string, string>>;
    /**
     * The directory this session's project-scoped memory is keyed on,
     * resolved by the owner once per agent. Absent means the workspace.
     */
    readonly instructionRoot?: InstructionRoot;
}

/**
 * Callbacks consumed only by `InboundCommandRouter`.
 *
 * The router handles model settings, pool edits, agent wear, permission
 * preferences, session name, and oneshot. Those are owner concerns, so the
 * router stays owner-side and the owner splits the `EngineCommand` stream
 * before a remote loop sees it. Nothing here is designed as a wire protocol,
 * because none of it crosses the boundary once that split exists.
 */
export interface InboundRouterHostHooks {
    readonly onInboundReady?: (inbound: InboundCommandRouter) => void;
    /** Additional durable work owned by the host, such as the native inbox. */
    readonly hasPendingDeliveryTurn?: () => boolean;
    /** Clears the host-side wake when the queued delivery was drained first. */
    readonly onDeliveryTurnDiscarded?: () => void;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly updateSessionModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<SessionModelSettingsResult | undefined>;
    readonly readSessionModelSettingsHistory?: () => readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[];
    readonly updateSessionPermissionMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly wearAgent?: InboundCommandRouterOptions["wearAgent"];
    readonly listAgents?: InboundCommandRouterOptions["listAgents"];
    readonly listSkills?: InboundCommandRouterOptions["listSkills"];
    readonly invokeSkill?: InboundCommandRouterOptions["invokeSkill"];
    readonly updateAgentDefaultPair?:
        InboundCommandRouterOptions["updateAgentDefaultPair"];
    readonly readApprovalModeOrigin?: () => SessionSettingOrigin | undefined;
    readonly poolAdd?: (
        entry: { readonly provider: string; readonly model: string },
        onStep: (step: {
            readonly step: string;
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
            readonly detail?: string;
        }) => void,
        options?: { readonly verify?: boolean },
    ) => Promise<{
        readonly verdict: PoolAdmissionVerdict;
        readonly reason?: string;
        readonly statusCode?: number;
        readonly settings?: ModelTurnSettings;
    }>;
    readonly poolRemove?: (
        entry: { readonly provider: string; readonly model: string },
    ) => Promise<ModelTurnSettings | undefined>;
    readonly refreshCatalog?: (
        provider: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly poolName?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly poolMove?: (
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly addPermissionPreference?: (
        when: PermissionPredicate,
    ) => Promise<PermissionPreference | undefined>;
    readonly removePermissionPreference?: (id: string) => Promise<boolean>;
    readonly updateSessionName?: (
        name: string | null,
    ) => Promise<string | null | undefined>;
    readonly sendTimelineReply?: (
        ownerId: string,
        reply: TimelineReplyUpdate,
    ) => void;
    readonly sendSessionNameReply?: (
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ) => void;
    readonly oneshot?: InboundCommandRouterOptions["oneshot"];
    readonly sendOneshotReply?: InboundCommandRouterOptions["sendOneshotReply"];
}

/**
 * Everything the loop needs that is not JSON.
 *
 * Absent means the owner does not offer that capability, which is a distinct
 * state from offering it and getting nothing back: an absent `effortPool` is
 * not an empty pool.
 */
export interface RunHeadlessLoopServices {
    // Live objects. Each names the JSON form it would take on a wire.

    /**
     * The durable session. A remote loop holds no store: it receives the
     * message array at start and sends `session.append { record }` for every
     * record, with the owner performing the write.
     */
    readonly sessionStore?: SessionStore;
    /**
     * Bidirectional. The loop emits engine events into it, and the owner also
     * emits into it for deliveries and parent notifications. On a wire that is
     * `event { ... }` notifications from the loop plus `inject { event }`
     * notifications from the owner, so this is the one member that needs the
     * owner-to-loop direction.
     */
    readonly eventBus?: EngineEventBus;
    /** JSON form: `effort.read` / `effort.record` against an owner-held pool. */
    readonly effortPool?: EffortPool;
    /** JSON form: a `modelFailure { ... }` notification to the owner. */
    readonly modelFailureLedger?: ModelFailureLedger;
    /** JSON form: a `reviewLog { ... }` notification to the owner. */
    readonly reviewLog?: ReviewLog;
    /**
     * JSON form: `hook.preToolUse`, `hook.postToolUse`, and `hook.preTurn`
     * requests with JSON replies, since the hook payloads are already plain data.
     */
    readonly hooks?: ToolHooks;
    /**
     * The process root shared by this session and its subagents. A remote loop
     * owns its own children by construction, so this member disappears rather
     * than becoming a message.
     */
    readonly processRegistry?: ManagedProcessRegistry;
    /**
     * Tools backed by the extension host. `definition` is already JSON, but
     * `execute` is a live closure taking a live `ToolRuntime`. JSON form:
     * send the definitions at start, then `tool.execute { callId, name,
     * input }` with a JSON reply, plus `cancel { callId }` for the signal.
     * The `ToolRuntime` argument does not cross: the extension host is
     * owner-side and holds its own.
     */
    readonly extensionTools?: readonly RegisteredTool[];
    /**
     * Strategy and bound models, read at each compact. Absent means this
     * compact is skipped. The strategy and the numbers are JSON; `models` is a
     * record of live completion functions, whose JSON form is
     * `complete { callId, role, request }` with a reply.
     */
    readonly compaction?: SessionCompactionOptions;

    // Callbacks. Each is already a JSON request with a JSON reply.

    /** See `LoopPolicy`. */
    readonly readPolicy?: () => LoopPolicy;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly readAgentWear?: () => AgentWearSnapshot | undefined;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    /**
     * Durable preferences, read on every decision rather than captured once,
     * so an add or remove through the router takes effect on the next tool
     * call without restarting the loop.
     */
    readonly readPermissionPreferences?: () => readonly PermissionPreference[];
    /**
     * The reviewer route as it stands now, read at each review. A reviewer
     * chosen mid-session has to reach the session that chose it, so
     * `LoopPolicy.reviewer` is only the starting point.
     */
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    /**
     * JSON in, JSON out, plus an `AbortSignal`. On a wire: `review { callId,
     * request }` with a reply, and `cancel { callId }`.
     */
    readonly reviewToolCall?: ReviewToolCall;
    /**
     * Covers every effect type the owner enables. The effect and the context
     * are already plain data and the result is a `ToolOutput`, so this is
     * `effect.apply { callId, effect, context }` with a reply, plus `cancel
     * { callId }`. `pool_add` reports progress, which is a stream of
     * `progress { callId, step }` notifications ending at that reply.
     */
    readonly applyToolEffect?: ApplyToolEffect;
    /** Host-owned configuration workflow, callable from an isolated worker. */
    readonly requestMissingSubagentConfiguration?:
        RequestMissingSubagentConfiguration;
    /** JSON form: `effect.commit { effect }` with an empty reply. */
    readonly applyCommittedToolEffect?: ApplyCommittedToolEffect;
    /**
     * JSON form: `contributions.load { instructionRoot, allowedSkills }` with
     * the contributions as the reply. `allowedSkills` names the skills the
     * worn agent may see; absent means all of them.
     */
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
    ) => Promise<readonly PromptContribution[]>;

    /** Owner-side, and not part of the wire. See `InboundRouterHostHooks`. */
    readonly router?: InboundRouterHostHooks;
}
