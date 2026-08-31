/**
 * The messages that cross between the host and a worker running the turn loop.
 *
 * The host owns everything durable: the session file, the event log, the
 * roster, permission grants, memory. The worker owns the turn loop and nothing
 * else. The test for which side a thing belongs on is whether killing the
 * worker loses it; if it does, it was on the wrong side.
 *
 * Every payload below is plain JSON. Two hazards this file must not lose:
 *
 * - `null` and absent are different values. A session record's `parentId` and
 *   a rewind's `headId` are meaningfully `null`; an optional field is absent.
 *   Nothing on this boundary may normalise one into the other.
 * - A rendering never crosses. What happened is a fact and travels; how a
 *   client would draw it stays in the client.
 *
 * Directions are named by the party that sends:
 *
 * - `WorkerRequest` / `WorkerReply`: the worker asks the host, and waits.
 * - `WorkerNotification`: the worker tells the host, and does not wait.
 * - `HostRequest` / `HostReply`: the host asks the worker, and waits.
 * - `HostNotification`: the host tells the worker, and does not wait.
 *
 * Two shapes have no JSON of their own and are expressed the same way
 * everywhere here: an `AbortSignal` argument becomes a `callId` on the request
 * plus a `call.cancel` notification the other way, and a progress callback
 * becomes a stream of `call.progress` notifications ending at the reply.
 */

import type { AgentWearSnapshot } from "../agents/wear.ts";
import type { LearnedFact } from "../model/pool-file.ts";
import type { ModelRef, ResolvedEffort } from "../model/effort-pool.ts";
import type { ReviewLogEntry } from "./review-log.ts";
import type { ModelMessage, ModelTool } from "../model/types.ts";
import type {
    HookCallOptions,
    PreToolUseOutcome,
} from "./hooks.ts";
import type {
    PostToolUseHookPayload,
    PreToolUseHookPayload,
    PreTurnHookPayload,
} from "../sdk/hooks.ts";
import type {
    ToolEffect,
    ToolEffectContext,
    ToolExecutionResult,
    ToolOutput,
} from "../tools/types.ts";
import type { AppliedToolEffectOutput } from "../tools/types.ts";
import type { CommitEffect } from "../tools/types.ts";
import type { EngineEvent } from "./events.ts";
import type { LoopPolicy } from "./loop-services.ts";
import type { InstructionRoot } from "./memory.ts";
import type { ModelTurnSettings } from "./model-settings.ts";
import type {
    ApprovalMode,
    PermissionGrantProposal,
    PermissionInspection,
    PermissionPreference,
} from "./permissions.ts";
import type {
    ContextualContributionContext,
    PromptContribution,
} from "./prompt-contributions.ts";
import type { ToolReviewDecision, ToolReviewRequest } from "./reviewer.ts";
import type { ToolReviewerSettings } from "./reviewer.ts";
import type { TimelineCommand } from "./protocol.ts";

/**
 * The owner state the loop reads mid-turn.
 *
 * Every read of it in `run-turn.ts` is synchronous, so none of them can become
 * a round trip without rewriting the loop. The host therefore pushes this whole
 * object with `state.changed` whenever any part of it changes, and the worker
 * answers each read from its last copy. Six fine-grained reads collapse into
 * one pushed snapshot and one message.
 *
 * A field is absent when the owner does not offer that capability at all,
 * which is a different state from offering it and getting nothing back.
 */
export interface LoopState {
    readonly policy: LoopPolicy;
    readonly modelSettings?: ModelTurnSettings;
    readonly agentWear?: AgentWearSnapshot;
    readonly approvalMode?: ApprovalMode;
    readonly permissionPreferences?: readonly PermissionPreference[];
    readonly reviewer?: ToolReviewerSettings;
}

/**
 * The effort pool as the worker sees it.
 *
 * `EffortPool.resolveEffort` is called synchronously while a model request is
 * being built, so it cannot be a round trip either. The host resolves each
 * model the session may use and pushes the answers; the worker reads them and
 * reports new facts back with `pool.learned`.
 */
export interface EffortPoolProjection {
    readonly efforts: Readonly<Record<string, ResolvedEffort>>;
    readonly imageSupport: Readonly<Record<string, boolean>>;
}

// Host to worker: notifications.

/** A record the host has just written to the session file, in file order. */
export interface SessionRecordNotification {
    readonly method: "session.record";
    readonly lineNumber: number;
    readonly record: Record<string, unknown>;
}

/** The owner state, pushed on every change. See `LoopState`. */
export interface StateChangedNotification {
    readonly method: "state.changed";
    readonly state: LoopState;
}

/**
 * The owner-to-loop direction of the per-agent event bus, which the host emits
 * into for deliveries and parent notifications.
 */
export interface EventInjectNotification {
    readonly method: "event.inject";
    readonly event: EngineEvent;
}

/** The effort pool, pushed. See `EffortPoolProjection`. */
export interface PoolChangedNotification {
    readonly method: "pool.changed";
    readonly projection: EffortPoolProjection;
}

/** Extension tool definitions, pushed when the extension host reloads. */
export interface ToolsChangedNotification {
    readonly method: "tools.changed";
    readonly definitions: readonly ModelTool[];
}

/** Cancels an in-flight host request. Stands in for an `AbortSignal`. */
export interface HostCancelNotification {
    readonly method: "call.cancel";
    readonly callId: string;
}

export type HostNotification =
    | SessionRecordNotification
    | StateChangedNotification
    | EventInjectNotification
    | PoolChangedNotification
    | ToolsChangedNotification
    | HostCancelNotification;

// Host to worker: requests.
//
// These are the calls the loop supplies to `InboundCommandRouter`. The router
// stays host-side, because it owns the client endpoint and handles model
// settings, pool edits, wear, permission preferences and consult. Keeping it
// there removes its own 23 callbacks from the wire entirely and means the
// client endpoint never reaches the worker. What is left is the router calling
// into the loop, which is this direction.

export interface AppendHarnessMessageRequest {
    readonly method: "loop.appendHarnessMessage";
    readonly text: string;
    readonly tone: HarnessTone;
}

export interface AppendContextRequest {
    readonly method: "loop.appendContext";
    readonly messages: readonly ModelMessage[];
    readonly harnessMessage: {
        readonly text: string;
        readonly tone: HarnessTone;
    };
}

export interface CompactNowRequest {
    readonly method: "loop.compactNow";
    readonly callId: string;
    readonly turnActive: boolean;
}

export interface HasPendingDeliveryTurnRequest {
    readonly method: "loop.hasPendingDeliveryTurn";
}

export interface ReadPermissionInspectionRequest {
    readonly method: "loop.readPermissionInspection";
}

export interface AddPermissionGrantsRequest {
    readonly method: "loop.addPermissionGrants";
    readonly grants: readonly PermissionGrantProposal[];
}

export interface RemovePermissionGrantRequest {
    readonly method: "loop.removePermissionGrant";
    readonly id: string;
}

export interface TimelineCommandRequest {
    readonly method: "loop.timelineCommand";
    readonly ownerId: string;
    readonly command: TimelineCommand;
}

export interface DetachTimelineOwnerRequest {
    readonly method: "loop.detachTimelineOwner";
    readonly ownerId: string;
}

export interface TimelineBlockedRequest {
    readonly method: "loop.timelineBlocked";
}

export type HostRequest =
    | AppendHarnessMessageRequest
    | AppendContextRequest
    | CompactNowRequest
    | HasPendingDeliveryTurnRequest
    | ReadPermissionInspectionRequest
    | AddPermissionGrantsRequest
    | RemovePermissionGrantRequest
    | TimelineCommandRequest
    | DetachTimelineOwnerRequest
    | TimelineBlockedRequest;

export interface EmptyReply {
    readonly result: null;
}

export interface PendingDeliveryTurnReply {
    readonly pending: boolean;
}

export interface PermissionInspectionReply {
    readonly inspection: PermissionInspection;
}

export interface RemovedReply {
    readonly removed: boolean;
}

export interface TimelineBlockedReply {
    readonly blocked: boolean;
}

export type HostReply =
    | EmptyReply
    | PendingDeliveryTurnReply
    | PermissionInspectionReply
    | RemovedReply
    | TimelineBlockedReply;

// Worker to host: requests.

export interface UpdateApprovalModeRequest {
    readonly method: "approval.update";
    readonly mode: ApprovalMode;
}

/** Cancellable. The `AbortSignal` is the `callId` plus `call.cancel`. */
export interface ReviewToolCallRequest {
    readonly method: "review.toolCall";
    readonly callId: string;
    readonly request: ToolReviewRequest;
}

/**
 * Cancellable, and `pool_add` reports progress through `call.progress`.
 *
 * `spawn_subagent` and `spawn_async_subagent` do not travel this way. Subagent
 * effects execute inside the worker, so a subagent is a child of its parent's
 * worker process and a kill reaches it. Applying them host-side would put model
 * loops back in the host and leave the runaway case exactly where it was.
 */
export interface ApplyToolEffectRequest {
    readonly method: "effect.apply";
    readonly callId: string;
    readonly effect: ToolEffect;
    readonly context: ToolEffectContext;
}

export interface CommitToolEffectRequest {
    readonly method: "effect.commit";
    readonly effect: CommitEffect;
}

export interface LoadContributionsRequest {
    readonly method: "contributions.load";
    readonly instructionRoot: InstructionRoot;
    /** Absent means every skill; a present empty list means none. */
    readonly allowedSkills?: readonly string[];
    readonly context?: ContextualContributionContext;
}

/**
 * One record for the host to write. The host is the single writer of the
 * session file and echoes each written record back with `session.record`, so
 * the worker's replica advances from the same stream every other reader sees.
 */
export interface SessionAppendRequest {
    readonly method: "session.append";
    readonly record: Record<string, unknown>;
}

/** Cancellable. The extension host holds the `ToolRuntime`; it never crosses. */
export interface ExecuteToolRequest {
    readonly method: "tool.execute";
    readonly callId: string;
    readonly name: string;
    readonly input: unknown;
}

export interface PreToolUseHookRequest {
    readonly method: "hook.preToolUse";
    readonly payload: PreToolUseHookPayload;
    readonly options: HookCallOptions;
}

export interface PostToolUseHookRequest {
    readonly method: "hook.postToolUse";
    readonly payload: PostToolUseHookPayload;
    readonly options: HookCallOptions;
}

export interface PreTurnHookRequest {
    readonly method: "hook.preTurn";
    readonly payload: PreTurnHookPayload;
    readonly options: HookCallOptions;
}

/** Cancellable. One call to a compaction-bound model. */
export interface CompactionCompleteRequest {
    readonly method: "compaction.complete";
    readonly callId: string;
    readonly role: string;
    readonly prompt: string;
    readonly system?: string;
}

/**
 * `agent.wear`. The loop asks, because wear is queued FIFO with the prompts and
 * only the loop knows when its turn comes; the host answers, because the agent
 * catalog and the session's worn agent are its.
 */
export interface WearAgentRequest {
    readonly method: "agent.wear";
    readonly name: string;
}

export type WorkerRequest =
    | WearAgentRequest
    | UpdateApprovalModeRequest
    | ReviewToolCallRequest
    | ApplyToolEffectRequest
    | CommitToolEffectRequest
    | LoadContributionsRequest
    | SessionAppendRequest
    | ExecuteToolRequest
    | PreToolUseHookRequest
    | PostToolUseHookRequest
    | PreTurnHookRequest
    | CompactionCompleteRequest;

export interface WearAgentReply {
    /** Absent when the owner has no such agent, or declined. */
    readonly worn?: {
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly notice?: string;
    };
}

export interface ApprovalModeReply {
    /** Absent when the owner declined the change. */
    readonly mode?: ApprovalMode;
}

export interface ReviewDecisionReply {
    readonly decision: ToolReviewDecision;
}

export interface AppliedEffectReply {
    readonly output: AppliedToolEffectOutput;
}

export interface ContributionsReply {
    readonly contributions: readonly PromptContribution[];
}

export interface ToolResultReply {
    readonly result: ToolExecutionResult;
}

export interface PreToolUseReply {
    readonly outcome: PreToolUseOutcome;
}

/**
 * One summarizer call. `unavailable` is a successful reply, not a pipe
 * error, so the ladder can still see whether more room would change the
 * outcome.
 */
export interface CompactionCompleteReply {
    readonly text?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly unavailable?: {
        readonly reason: string;
        readonly roomRelated: boolean;
    };
}

export type WorkerReply =
    | EmptyReply
    | WearAgentReply
    | ApprovalModeReply
    | ReviewDecisionReply
    | AppliedEffectReply
    | ContributionsReply
    | ToolResultReply
    | PreToolUseReply
    | CompactionCompleteReply;

// Worker to host: notifications.

/**
 * An engine event the loop produced.
 *
 * The host's own subscribers ride this one stream: the model-failure ledger and
 * the event log are host-side subscribers of the events the worker already
 * sends, so neither is a message of its own.
 */
export interface EventEmitNotification {
    readonly method: "event.emit";
    readonly event: EngineEvent;
}

export interface ReviewLogNotification {
    readonly method: "reviewLog.append";
    readonly entry: ReviewLogEntry;
}

/** A fact the provider just told the loop, for the host to record. */
export interface PoolLearnedNotification {
    readonly method: "pool.learned";
    readonly ref: ModelRef;
    readonly key: string;
    readonly fact: LearnedFact;
}

/** Progress on an in-flight worker request. Ends at that request's reply. */
export interface CallProgressNotification {
    readonly method: "call.progress";
    readonly callId: string;
    readonly step: {
        readonly step: string;
        readonly label: string;
        readonly status: "running" | "passed" | "failed" | "skipped";
        readonly detail?: string;
    };
}

/** Cancels an in-flight host request. */
export interface WorkerCancelNotification {
    readonly method: "call.cancel";
    readonly callId: string;
}

export type WorkerNotification =
    | EventEmitNotification
    | ReviewLogNotification
    | PoolLearnedNotification
    | CallProgressNotification
    | WorkerCancelNotification;

export type HarnessTone = "primary" | "soft" | "error";

/** Every method name on the boundary, in both directions. */
export const HOST_PROTOCOL_METHODS = [
    "session.record",
    "state.changed",
    "event.inject",
    "pool.changed",
    "tools.changed",
    "call.cancel",
    "loop.appendHarnessMessage",
    "loop.appendContext",
    "loop.compactNow",
    "loop.hasPendingDeliveryTurn",
    "loop.readPermissionInspection",
    "loop.addPermissionGrants",
    "loop.removePermissionGrant",
    "loop.timelineCommand",
    "loop.detachTimelineOwner",
    "loop.timelineBlocked",
    "agent.wear",
    "approval.update",
    "review.toolCall",
    "effect.apply",
    "effect.commit",
    "contributions.load",
    "session.append",
    "tool.execute",
    "hook.preToolUse",
    "hook.postToolUse",
    "hook.preTurn",
    "compaction.complete",
    "event.emit",
    "reviewLog.append",
    "pool.learned",
    "call.progress",
] as const;

/**
 * Members of `RunHeadlessLoopServices` that have no message, and why.
 *
 * Kept here rather than in a document because the reason is what stops each
 * from being added back by a later reading of the services list.
 */
export const SERVICES_THAT_DO_NOT_CROSS = {
    /** A remote worker owns its children, so there is nothing to share. */
    processRegistry: "worker-owned",
    /** A host-side subscriber of the events `event.emit` already carries. */
    modelFailureLedger: "derived from events",
    /**
     * Owner-side. Its hooks stay with it, and the client endpoint it holds
     * never reaches the worker. `agent.wear` is the one exception: wear is
     * queued FIFO with the prompts, so the loop has to be the one that asks.
     */
    router: "host-owned",
} as const;
