import type {
    ConfigurationRequiredUiRequest,
    EngineEventSubscriber,
    PoolAdmissionVerdict,
    ToolApprovalUiRequest,
    UiResponse,
    UserQuestionUiRequest,
} from "./events.ts";
import type {
    AssistantMessage,
    ModelMessage,
    ModelReasoningEffort,
    ModelSubstitution,
    ModelUsage,
    ToolPresentation,
} from "../model/types.ts";
import type {
    DeveloperSettingsPatch,
    ModelSettingsPatch,
    ModelTurnSettings,
    ReviewerSettingsPatch,
} from "./model-settings.ts";
import {
    contextWindowForModel,
    isDeveloperSettingsPatch,
    isReviewerSettingsPatch,
} from "./model-settings.ts";
import {
    measureCompletedAssistant,
    measureMessages,
    measureReportedUsage,
    scaleProjectionTo,
    type ContextMeasurement,
} from "./context-measurement.ts";
import {
    isApprovalMode,
    isPermissionPredicate,
    type ApprovalMode,
    type PermissionInspection,
    type PermissionPredicate,
} from "./permissions.ts";
import type {
    ToolReviewRiskLevel,
    ToolReviewUserAuthorization,
} from "./reviewer.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type { SessionSettingOrigin } from "../store/session-store.ts";
import type { PromptQueueState } from "./prompt-queue.ts";

export type AgentStatus = "idle" | "working" | "waiting";

export interface AttachmentRef {
    /** The attachment ID the prompt was sent with. */
    readonly id: string;
    /** The file the image came from, absent once its record is gone. */
    readonly name?: string;
}

/** Resolves an attachment ID to the file name it was attached from. */
export type AttachmentNameLookup = (id: string) => string | undefined;

export interface UserTranscriptEntry {
    readonly id?: string;
    readonly kind: "user";
    readonly text: string;
    readonly attachments?: readonly AttachmentRef[];
}

export interface AssistantTranscriptEntry {
    readonly id?: string;
    readonly kind: "assistant";
    readonly text: string;
}

export interface ToolTranscriptEntry {
    readonly id?: string;
    readonly kind: "tool";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResultTranscriptEntry {
    readonly id?: string;
    readonly kind: "tool_result";
    readonly tool: string;
    readonly output: string;
    readonly isError: boolean;
    readonly processId?: string;
}

export interface ModelSubstitutionTranscriptEntry {
    readonly id?: string;
    readonly kind: "model_substitution";
    readonly substitution: ModelSubstitution;
}

// Re-exported from where `ModelSubstitution` itself lives, so the ladder in
// `src/model` and every client reach the same sentence without a client
// importing the engine.
export { formatModelSubstitution } from "../model/types.ts";

export interface PresentationTranscriptEntry {
    readonly id?: string;
    readonly kind: "presentation";
    readonly presentation: ToolPresentation;
}

export interface ErrorTranscriptEntry {
    readonly id?: string;
    readonly kind: "error";
    readonly outcome?: "error" | "aborted";
    readonly detail?: string;
}

/**
 * A turn that ended with nothing to show. Silence and a stalled client look the
 * same in a transcript, so the absence is written down rather than left blank.
 */
export interface EmptyTranscriptEntry {
    readonly id?: string;
    readonly kind: "empty";
}

export interface HarnessTranscriptEntry {
    readonly id?: string;
    readonly kind: "harness";
    readonly text: string;
    readonly tone: "primary" | "soft" | "error";
}

/**
 * Every entry carries the ID of the stored message it was projected from,
 * suffixed with its position among the entries that message produced, because
 * one message can yield several rows. The field is absent when the projection
 * source has no stored identity, such as a live checkpoint taken from an
 * in-memory array in a test.
 */
export type TranscriptEntry =
    | UserTranscriptEntry
    | AssistantTranscriptEntry
    | ToolTranscriptEntry
    | ToolResultTranscriptEntry
    | PresentationTranscriptEntry
    | ModelSubstitutionTranscriptEntry
    | ErrorTranscriptEntry
    | EmptyTranscriptEntry
    | HarnessTranscriptEntry;

export interface PromptCommand {
    readonly type: "prompt";
    readonly content: string;
    readonly attachmentIds?: readonly string[];
}

export interface AppendHarnessMessageCommand {
    readonly type: "append_harness_message";
    readonly text: string;
    readonly tone: "primary" | "soft" | "error";
}

/**
 * A silent one-shot model call. Named model, messages in, text out.
 *
 * It is not a turn: no tools, no streaming, nothing appended to the session,
 * and no change to the agent's own model selection. `systemPrompt` is whatever
 * the caller passes; omit it and the host sends "". The named model is used or
 * the request is refused; Vera never substitutes another one here.
 */
export interface OneshotCommand {
    readonly type: "oneshot";
    readonly requestId: string;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly systemPrompt?: string;
    readonly messages: readonly OneshotMessage[];
    readonly maxTokens?: number;
}

export interface OneshotMessage {
    readonly role: "user" | "assistant";
    readonly content: string;
}

export interface OneshotResultUpdate {
    readonly type: "oneshot_result";
    readonly requestId: string;
    readonly text: string;
    readonly model: string;
    readonly provider?: string;
}

export interface OneshotRejectedUpdate {
    readonly type: "oneshot_rejected";
    readonly requestId: string;
    readonly reason: string;
}

export interface AttachImageCommand {
    readonly type: "attach_image";
    readonly requestId: string;
    readonly path: string;
}

export interface AbortCommand {
    readonly type: "abort";
}

export interface ReleaseQueuedPromptsCommand {
    readonly type: "release_queued_prompts";
    readonly mode: "one" | "all";
}

export interface UiResponseCommand {
    readonly type: "ui_response";
    readonly requestId: string;
    readonly response: UiResponse;
}

export interface GetModelSettingsCommand {
    readonly type: "get_model_settings";
    readonly requestId: string;
}

export interface UpdateModelSettingsCommand {
    readonly type: "update_model_settings";
    readonly requestId: string;
    readonly patch: ModelSettingsPatch;
}

/**
 * Dial this session, and nothing else.
 *
 * A separate command rather than a scope flag on `update_model_settings`: the
 * flag would parse on a host that has never heard of it and then quietly write
 * the global defaults anyway, which is the exact failure the dial strip cannot
 * afford. An old host refuses an unknown command outright, which is honest.
 */
export interface UpdateSessionModelSettingsCommand {
    readonly type: "update_session_model_settings";
    readonly requestId: string;
    readonly patch: ModelSettingsPatch;
}

/**
 * Wear an agent, in FIFO order with the prompts already queued.
 *
 * Not applied on arrival: a prompt enqueued before this one snapshotted the
 * old agent's settings and would pick up the new agent's tools at turn start,
 * which is a turn running as neither agent.
 */
export interface WearAgentCommand {
    readonly type: "wear_agent";
    readonly requestId: string;
    readonly name: string;
}

export interface ListAgentsCommand {
    readonly type: "list_agents";
    readonly requestId: string;
}

export interface ListSkillsCommand {
    readonly type: "list_skills";
    readonly requestId: string;
}

export interface InvokeSkillCommand {
    readonly type: "invoke_skill";
    readonly requestId: string;
    readonly name: string;
    readonly argumentsText: string;
}

/**
 * The one writer into an agent file, and it writes one key.
 *
 * There is deliberately no general agent-writing command: an agent is a file
 * you edit with your editor, and a wire command that could rewrite it would
 * make the file the second copy of the truth.
 */
export interface UpdateAgentDefaultPairCommand {
    readonly type: "update_agent_default_pair";
    readonly requestId: string;
    readonly name: string;
    /** Null clears the key. */
    readonly pair: { readonly name: string; readonly effort?: string } | null;
}

export interface GetSessionModelSettingsHistoryCommand {
    readonly type: "get_session_model_settings_history";
    readonly requestId: string;
}

/**
 * Set the permission mode for this session without touching the host default.
 *
 * The pre-existing `update_permissions` keeps its behaviour, which is to write
 * both; it is what the explicit "set as global default" action calls.
 */
export interface UpdateSessionPermissionModeCommand {
    readonly type: "update_session_permission_mode";
    readonly requestId: string;
    readonly mode: ApprovalMode;
}

/**
 * Admitting a model is not choosing one, so this is its own command rather
 * than a field on `update_model_settings`: adding a model the user is only
 * looking at must not switch the turn to it.
 *
 * Plain admission never reaches the provider: the model enters the pool with
 * whatever the catalog knows about it, unverified and usable. `verify` is the
 * separate, deliberate request to spend probe calls on it, and it is the only
 * form that answers in stages: `pool_admission_progress` per check, then a
 * terminal `pool_admission_result`. Both forms end in the ordinary
 * `model_settings` update with the refreshed pool.
 */
export interface PoolAddCommand {
    readonly type: "pool_add";
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    /** Runs the probes and records what they find. Absent means admit only. */
    readonly verify?: boolean;
}

/**
 * Removal is the destructive side and stays a plain command: no probes, one
 * `model_settings` reply. The response's `references` warning surface lives
 * client-side for now; the engine just removes.
 */
export interface PoolRemoveCommand {
    readonly type: "pool_remove";
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
}

/**
 * Asks one provider for its model list now, rather than waiting out the
 * snapshot's age. The reply is a `model_settings` carrying the list with that
 * provider's rows replaced, so a client refreshes and re-renders on the same
 * round trip; a provider that could not be asked is refused instead.
 *
 * The provider is named rather than optional. A command whose narrowing field
 * is unreadable would otherwise widen into asking every provider at once,
 * which is the most expensive thing this can do and the opposite of what was
 * sent.
 */
export interface CatalogRefreshCommand {
    readonly type: "catalog_refresh";
    readonly requestId: string;
    readonly provider: string;
}

/**
 * Names a pool entry, or clears its name with `null`. The name is that
 * entry's identity rather than a setting on it, so a name another entry
 * already holds, a name shaped like a model id, or a model outside the pool
 * is refused instead of stored.
 */
export interface PoolNameCommand {
    readonly type: "pool_name";
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly name: string | null;
}

/**
 * Moves a pool entry within the pool's declared order, by `delta` places.
 *
 * Order is not decoration: the failsafe rung walks the pool in file order, so
 * this sets the subagent preference order as much as it sets which entries sit
 * near the top of the strip. A move past either end clamps.
 */
export interface PoolMoveCommand {
    readonly type: "pool_move";
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly delta: number;
}

export interface GetPermissionsCommand {
    readonly type: "get_permissions";
    readonly requestId: string;
}

export interface UpdatePermissionsCommand {
    readonly type: "update_permissions";
    readonly requestId: string;
    readonly mode: ApprovalMode;
}

/**
 * Both preference commands reply with the same `permissions` update that
 * `get_permissions` and `update_permissions` already send, because that update
 * carries the full refreshed `inspection` including `activePreferences`. A
 * durable allow the user cannot see is the failure mode this tier exists to
 * avoid, so add/remove and inspect deliberately share one reply shape.
 */
export interface AddPermissionPreferenceCommand {
    readonly type: "add_permission_preference";
    readonly requestId: string;
    readonly when: PermissionPredicate;
}

export interface RemovePermissionPreferenceCommand {
    readonly type: "remove_permission_preference";
    readonly requestId: string;
    readonly id: string;
}

/**
 * Revokes one live session grant. Separate from
 * `remove_permission_preference` because the two tiers live in different
 * places: a grant is a session-log entry, a preference is a file in the home
 * directory. One command covering both would have to guess which store an ID
 * belongs to.
 */
export interface RemovePermissionGrantCommand {
    readonly type: "remove_permission_grant";
    readonly requestId: string;
    readonly id: string;
}

export interface UpdateSessionNameCommand {
    readonly type: "update_session_name";
    readonly requestId: string;
    readonly name: string | null;
}

/**
 * Compacts now, on the same strategy the session compacts itself with. The
 * point of asking is to compact before the window is nearly full, so this one
 * skips the trigger fraction; every other rule the engine applies still holds.
 */
export interface CompactCommand {
    readonly type: "compact";
    readonly requestId: string;
}

export interface ListTimelineCommand {
    readonly type: "list_timeline";
    readonly requestId: string;
}

export interface PreviewTimelineActionCommand {
    readonly type: "preview_timeline_action";
    readonly requestId: string;
    readonly boundaryId: string;
    readonly action: "rewind_conversation";
}

export interface ApplyTimelineActionCommand {
    readonly type: "apply_timeline_action";
    readonly requestId: string;
    readonly planId: string;
}

export type TimelineCommand =
    | ListTimelineCommand
    | PreviewTimelineActionCommand
    | ApplyTimelineActionCommand;

export type ClientCommand =
    | PromptCommand
    | AppendHarnessMessageCommand
    | AttachImageCommand
    | AbortCommand
    | ReleaseQueuedPromptsCommand
    | UiResponseCommand
    | GetModelSettingsCommand
    | UpdateModelSettingsCommand
    | UpdateSessionModelSettingsCommand
    | GetSessionModelSettingsHistoryCommand
    | UpdateSessionPermissionModeCommand
    | WearAgentCommand
    | ListAgentsCommand
    | ListSkillsCommand
    | InvokeSkillCommand
    | UpdateAgentDefaultPairCommand
    | OneshotCommand
    | PoolAddCommand
    | PoolRemoveCommand
    | CatalogRefreshCommand
    | PoolNameCommand
    | PoolMoveCommand
    | GetPermissionsCommand
    | UpdatePermissionsCommand
    | AddPermissionPreferenceCommand
    | RemovePermissionPreferenceCommand
    | RemovePermissionGrantCommand
    | UpdateSessionNameCommand
    | CompactCommand
    | TimelineCommand;

export interface HistoryUpdate {
    readonly type: "history";
    readonly entries: readonly TranscriptEntry[];
    readonly seq: number;
    /**
     * Set on a replayed checkpoint when the agent is not idle. The engine
     * never sets it: a live checkpoint is always preceded by the updates that
     * carry the status, and only a replay loses them.
     */
    readonly status?: AgentStatus;
    readonly context?: ContextMeasurement;
    readonly usage?: SessionModelUsage;
    readonly promptQueue?: PromptQueueState;
}

export interface PromptQueueUpdate {
    readonly type: "prompt_queue";
    readonly queue: PromptQueueState;
    readonly seq: number;
}

export interface SessionModelUsageRow extends ModelUsage {
    readonly provider: string;
    readonly model: string;
    readonly calls: number;
    readonly durationMs: number;
    readonly callsWithoutCost: number;
}

export interface SessionModelUsage {
    readonly rows: readonly SessionModelUsageRow[];
}

/**
 * How full the context window is, as the engine measured it. Sent whenever the
 * number moves: once per model round from the projected request, and again
 * with the provider's own count when a response reports one.
 */
export interface ContextUpdate {
    readonly type: "context";
    readonly measurement: ContextMeasurement;
    readonly seq: number;
}

export interface ModelRetryActivityUpdate {
    readonly type: "model_activity";
    readonly phase: "retrying";
    readonly model: string;
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly retryAt: string;
    readonly failure: {
        readonly kind: ProviderFailure["kind"];
        readonly statusCode?: number;
    };
    /** The prior partial model attempt was rejected; this retry replaces it. */
    readonly replacesPartialAttempt?: true;
    readonly seq: number;
}

export type ModelActivityUpdate = ModelRetryActivityUpdate;

/**
 * The turn ran on something other than what was asked for. Covers both a
 * coarsened reasoning effort and a fallback to a different model, because a
 * client shows the same thing either way: this is not what you requested.
 */
export interface ModelSubstitutionUpdate {
    readonly type: "model_substitution";
    readonly model: string;
    readonly requested: string;
    /** Absent means no reasoning level was sent at all. */
    readonly using?: string;
    readonly reason: string;
    readonly scope: "effort" | "model";
    /**
     * Whether the parent turn was substituted, or a spawn inside it was.
     *
     * `scope` already means something else — which dial moved — so this is a
     * field of its own rather than a third value there. Only a `turn`
     * substitution belongs in the status line: a subagent's fallback is the
     * subagent's business and reaches the transcript alone.
     */
    readonly source: "turn" | "subagent";
    readonly seq: number;
}

/**
 * Compaction starting and ending. The transcript is unchanged either way, so
 * without this a client would see the context number drop between turns with
 * nothing to attribute it to, and a failed compaction would be silent.
 */
export interface CompactionUpdate {
    readonly type: "compaction";
    readonly phase: "started" | "finished";
    readonly strategy: string;
    readonly provider?: string;
    readonly model?: string;
    readonly outcome?:
        | "compacted"
        | "not_needed"
        | "no_boundary"
        | "rejected"
        | "unavailable"
        | "cancelled"
        | "busy";
    /** Set when the compaction was stopped by the turn it ran inside. */
    readonly stoppedWithTurn?: boolean;
    readonly reason?: string;
    /** Set on the started phase only, for a configuration mismatch. */
    readonly warning?: string;
    readonly before?: number;
    readonly after?: number;
    readonly seq: number;
}

export interface UserPromptUpdate {
    readonly type: "user_prompt";
    readonly content: string;
    readonly attachments?: readonly AttachmentRef[];
    readonly seq: number;
}

export interface AssistantDeltaUpdate {
    readonly type: "assistant_delta";
    readonly text: string;
    readonly seq: number;
}

/**
 * Reasoning text as it streams. Live-only: it is never persisted, so a client
 * that misses it has nothing to catch up on.
 */
export interface AssistantThinkingUpdate {
    readonly type: "assistant_thinking";
    readonly text: string;
    readonly seq: number;
}

export interface ToolStartedUpdate {
    readonly type: "tool_started";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly seq: number;
}

export interface ToolReviewUpdate {
    readonly type: "tool_review";
    readonly tool: string;
    readonly decision: "allow" | "deny" | "unavailable";
    readonly reason: string;
    /** The reviewer's own scoring, so clients can show what drove the call. */
    readonly riskLevel: ToolReviewRiskLevel;
    readonly userAuthorization: ToolReviewUserAuthorization;
    readonly seq: number;
}

/**
 * The consecutive-denial breaker acted on a tool.
 *
 * Carries what happened and nothing about how to say it: which tool, how many
 * automatic denials in a row, and whether the tool was withheld for the rest
 * of the turn or the turn was ended. A client that shows nothing is still
 * correct; without this the reason a tool stopped being offered is recoverable
 * only from the session's event log.
 */
export interface ToolBreakerTrippedUpdate {
    readonly type: "tool_breaker_tripped";
    readonly tool: string;
    readonly denials: number;
    readonly action: "withheld" | "ended-turn";
    readonly seq: number;
}

export interface ToolFinishedUpdate {
    readonly type: "tool_finished";
    readonly tool: string;
    readonly output?: string;
    readonly isError?: boolean;
    readonly processId?: string;
    readonly seq: number;
}

export interface ToolPresentationUpdate {
    readonly type: "tool_presentation";
    readonly tool: string;
    readonly presentation: ToolPresentation;
    readonly seq: number;
}

export interface TurnFinishedUpdate {
    readonly type: "turn_finished";
    readonly outcome?: "error" | "aborted";
    readonly error?: string;
    /** The turn ended with no text, no tool call, and no reasoning. */
    readonly empty?: true;
    readonly usage?: SessionModelUsage;
    readonly seq: number;
}

export interface AgentFailedUpdate {
    readonly type: "agent_failed";
    readonly failureId: string;
    readonly detail: string;
    readonly seq: number;
}

export interface StatusUpdate {
    readonly type: "status";
    readonly state: AgentStatus;
    readonly seq: number;
}

export interface TaskNotificationUpdate {
    readonly type: "task_notification";
    readonly deliveryId: string;
    readonly sourceAgentId: string;
    readonly content: string;
    readonly kind?: "attention" | "completion" | "peer";
    readonly seq: number;
}

export interface NoticeUpdate {
    readonly type: "notice";
    readonly key: string;
    readonly count: number;
    readonly seq: number;
}

export interface ToolApprovalUiRequestUpdate {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: ToolApprovalUiRequest;
    readonly seq: number;
}

export interface UserQuestionUiRequestUpdate {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: UserQuestionUiRequest;
    readonly seq: number;
}

export interface ConfigurationRequiredUiRequestUpdate {
    readonly type: "ui_request";
    readonly requestId: string;
    readonly request: ConfigurationRequiredUiRequest;
    readonly seq: number;
}

export type UiRequestUpdate =
    | ToolApprovalUiRequestUpdate
    | UserQuestionUiRequestUpdate
    | ConfigurationRequiredUiRequestUpdate;

export function isToolApprovalUiRequestUpdate(
    update: UiRequestUpdate,
): update is ToolApprovalUiRequestUpdate {
    return update.request.type === "tool_approval";
}

export function isUserQuestionUiRequestUpdate(
    update: UiRequestUpdate,
): update is UserQuestionUiRequestUpdate {
    return update.request.type === "user_question";
}

export function isConfigurationRequiredUiRequestUpdate(
    update: UiRequestUpdate,
): update is ConfigurationRequiredUiRequestUpdate {
    return update.request.type === "configuration_required";
}

export interface UiRequestClosedUpdate {
    readonly type: "ui_request_closed";
    readonly requestId: string;
    readonly seq: number;
}

export interface ModelSettingsUpdate {
    readonly type: "model_settings";
    readonly requestId: string;
    readonly settings: ModelTurnSettings;
    readonly pending: boolean;
    readonly updatedDefaults?: true;
    /** Present when the edit changed this session alone. Never with the above. */
    readonly updatedSession?: true;
    /** Where the session's setting now says it came from. */
    readonly origin?: SessionSettingOrigin;
    readonly seq: number;
}

/**
 * The agent in force, after a wear applied or a resume resolved one.
 *
 * `notice` carries what the user has to be told: that the definition moved
 * since it was worn, that the agent is gone, or that its default pair no
 * longer resolves. Silence is the normal case.
 */
export interface AgentWornUpdate {
    readonly type: "agent_worn";
    readonly requestId: string;
    readonly name: string;
    readonly tools?: readonly string[];
    readonly skills?: readonly string[];
    readonly posture?: string;
    readonly forbiddenAccess?: readonly string[];
    readonly notice?: string;
    readonly seq: number;
}

export interface AgentCatalogUpdate {
    readonly type: "agent_catalog";
    readonly requestId: string;
    readonly worn: string;
    readonly agents: readonly {
        readonly name: string;
        readonly description?: string;
        readonly scope: "project" | "user" | "extension";
        readonly writable: boolean;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
        readonly defaultPair?: {
            readonly name: string;
            readonly effort?: string;
        };
    }[];
    readonly notices: readonly string[];
    readonly seq: number;
}

export interface AgentRejectedUpdate {
    readonly type: "agent_rejected";
    readonly requestId: string;
    readonly reason: string;
    readonly seq: number;
}

export interface SkillCatalogUpdate {
    readonly type: "skill_catalog";
    readonly requestId: string;
    readonly skills: readonly {
        readonly name: string;
        readonly description: string;
        readonly disableModelInvocation: boolean;
    }[];
    readonly warnings: readonly string[];
    readonly seq: number;
}

export interface SkillInvocationAcceptedUpdate {
    readonly type: "skill_invocation_accepted";
    readonly requestId: string;
    readonly name: string;
    readonly prompt: string;
    readonly queued: boolean;
    readonly seq: number;
}

export interface SkillInvocationRejectedUpdate {
    readonly type: "skill_invocation_rejected";
    readonly requestId: string;
    readonly name: string;
    readonly reason: string;
    readonly seq: number;
}

/**
 * Every model setting the session has held, oldest first.
 *
 * The dial strip derives its recents from this rather than keeping a list of
 * its own, so what the strip offers cannot drift from what the session did.
 */
export interface SessionModelSettingsHistoryUpdate {
    readonly type: "session_model_settings_history";
    readonly requestId: string;
    readonly entries: readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[];
    readonly seq: number;
}

export interface ModelSettingsRejectedUpdate {
    readonly type: "model_settings_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
    readonly seq: number;
}

/**
 * One admission check changed state. Steps arrive in order; a step appears
 * first as `running` and again with its outcome. The checklist a client shows
 * is exactly this stream: the engine decides the steps, the client only
 * renders them.
 */
export interface PoolAdmissionProgressUpdate {
    readonly type: "pool_admission_progress";
    readonly requestId: string;
    readonly step: string;
    readonly label: string;
    readonly status: "running" | "passed" | "failed" | "skipped";
    readonly detail?: string;
    readonly seq: number;
}

/**
 * The admission verdict, terminal for one `pool_add`. `added` carries the
 * verified levels through the ordinary `model_settings` update that follows;
 * `incompatible` records why; `unavailable` records nothing and invites retry;
 * `pool_write_refused` means the pool file, not the provider, turned the
 * entry away.
 */
export interface PoolAdmissionResultUpdate {
    readonly type: "pool_admission_result";
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly verdict: PoolAdmissionVerdict;
    readonly reason?: string;
    readonly statusCode?: number;
    readonly seq: number;
}

export interface PermissionsUpdate {
    readonly type: "permissions";
    readonly requestId: string;
    readonly mode: ApprovalMode;
    readonly pending: boolean;
    readonly inspection?: PermissionInspection;
    readonly origin?: SessionSettingOrigin;
    readonly seq: number;
}

export interface PermissionsRejectedUpdate {
    readonly type: "permissions_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
    readonly seq: number;
}

export interface SessionNameUpdate {
    readonly type: "session_name";
    readonly requestId: string;
    readonly name: string | null;
}

export interface SessionNameRejectedUpdate {
    readonly type: "session_name_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
}

export type SessionNameReplyUpdate =
    | SessionNameUpdate
    | SessionNameRejectedUpdate;

export interface TimelineBoundary {
    readonly userMessageId: string;
    readonly timestamp: string;
    readonly prompt: string;
    readonly attachments?: readonly AttachmentRef[];
    readonly position: number;
}

export interface TimelineUpdate {
    readonly type: "timeline";
    readonly requestId: string;
    readonly boundaries: readonly TimelineBoundary[];
}

export interface TimelineActionPlan {
    readonly planId: string;
    readonly expectedHeadId: string;
    readonly boundary: TimelineBoundary;
    readonly keptMessageCount: number;
    readonly setAsideMessageCount: number;
}

export interface TimelineActionPreviewUpdate {
    readonly type: "timeline_action_preview";
    readonly requestId: string;
    readonly plan: TimelineActionPlan;
}

export interface TimelineActionAppliedUpdate {
    readonly type: "timeline_action_applied";
    readonly requestId: string;
    readonly planId: string;
}

export type TimelineActionOperation = "preview" | "apply";

export type TimelineActionRejectionReason =
    | "busy"
    | "plan_expired"
    | "not_plan_owner"
    | "boundary_missing"
    | "session_changed"
    | "unavailable";

export interface TimelineActionRejectedUpdate {
    readonly type: "timeline_action_rejected";
    readonly requestId: string;
    readonly operation: TimelineActionOperation;
    readonly reason: TimelineActionRejectionReason;
}

export type TimelineReplyUpdate =
    | TimelineUpdate
    | TimelineActionPreviewUpdate
    | TimelineActionAppliedUpdate
    | TimelineActionRejectedUpdate;

export interface ImageAttachedUpdate {
    readonly type: "image_attached";
    readonly requestId: string;
    readonly attachment: {
        readonly id: string;
        readonly name: string;
        readonly mediaType: string;
        readonly bytes: number;
        readonly width: number;
        readonly height: number;
    };
}

export interface ImageAttachmentRejectedUpdate {
    readonly type: "image_attachment_rejected";
    readonly requestId: string;
    readonly error: string;
}

/**
 * A prompt the agent will not run, answered to the client that sent it.
 *
 * Sent rather than thrown so a client that tries stays connected and reads
 * why. The bounded print-mode agent is the case that needs it: its turn is
 * the host's, and a second prompt from an onlooker would change the run.
 */
export interface PromptRejectedUpdate {
    readonly type: "prompt_rejected";
    readonly reason: string;
}

export type ImageAttachmentReplyUpdate =
    | ImageAttachedUpdate
    | ImageAttachmentRejectedUpdate;

export type AgentUpdate =
    | HistoryUpdate
    | UserPromptUpdate
    | AssistantDeltaUpdate
    | AssistantThinkingUpdate
    | ToolStartedUpdate
    | ToolReviewUpdate
    | ToolBreakerTrippedUpdate
    | ToolFinishedUpdate
    | ToolPresentationUpdate
    | TurnFinishedUpdate
    | AgentFailedUpdate
    | PromptQueueUpdate
    | ContextUpdate
    | ModelActivityUpdate
    | ModelSubstitutionUpdate
    | CompactionUpdate
    | StatusUpdate
    | TaskNotificationUpdate
    | NoticeUpdate
    | UiRequestUpdate
    | UiRequestClosedUpdate
    | ModelSettingsUpdate
    | SessionModelSettingsHistoryUpdate
    | AgentWornUpdate
    | AgentCatalogUpdate
    | AgentRejectedUpdate
    | SkillCatalogUpdate
    | SkillInvocationAcceptedUpdate
    | SkillInvocationRejectedUpdate
    | ModelSettingsRejectedUpdate
    | PoolAdmissionProgressUpdate
    | PoolAdmissionResultUpdate
    | PermissionsUpdate
    | PermissionsRejectedUpdate
    | SessionNameReplyUpdate
    | TimelineReplyUpdate
    | ImageAttachmentReplyUpdate
    | OneshotResultUpdate
    | OneshotRejectedUpdate
    | PromptRejectedUpdate;

export interface AgentUpdateSender {
    send(update: AgentUpdate): void;
}

export interface ProtocolEncoder extends EngineEventSubscriber {
    checkpoint(
        messages: readonly ModelMessage[],
        messageIds?: MessageIdLookup,
        context?: ContextMeasurement,
        recipe?: ContextMeasurement,
    ): void;
    /**
     * Replace the encoder's last-request occupancy. Rewind uses this so a
     * dropped turn's measurement cannot floor the next checkpoint.
     */
    restoreContext(measurement?: ContextMeasurement): void;
}

export function parseClientCommand(value: unknown): ClientCommand | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const command = value as Record<string, unknown>;
    if (
        command.type === "prompt"
        && typeof command.content === "string"
        && isAttachmentIds(command.attachmentIds)
    ) {
        return {
            type: "prompt",
            content: command.content,
            ...(command.attachmentIds === undefined
                ? {}
                : { attachmentIds: [...command.attachmentIds] }),
        };
    }
    if (
        command.type === "append_harness_message"
        && isNonEmptyString(command.text)
        && (command.tone === "primary"
            || command.tone === "soft"
            || command.tone === "error")
    ) {
        return {
            type: "append_harness_message",
            text: command.text.trim(),
            tone: command.tone,
        };
    }
    if (command.type === "abort") {
        return { type: "abort" };
    }
    if (
        command.type === "release_queued_prompts"
        && (command.mode === "one" || command.mode === "all")
    ) {
        return { type: "release_queued_prompts", mode: command.mode };
    }
    if (
        command.type === "attach_image"
        && isRequestId(command.requestId)
        && typeof command.path === "string"
        && command.path.length > 0
    ) {
        return {
            type: "attach_image",
            requestId: command.requestId,
            path: command.path,
        };
    }
    if (
        command.type === "ui_response"
        && isRequestId(command.requestId)
        && typeof command.response === "object"
        && command.response !== null
    ) {
        const response = command.response as Record<string, unknown>;
        if (
            response.type === "tool_approval"
            && (
                response.decision === "allow_once"
                || response.decision === "allow_similar"
                || response.decision === "allow_always"
                || response.decision === "deny"
            )
        ) {
            return {
                type: "ui_response",
                requestId: command.requestId,
                response: {
                    type: "tool_approval",
                    decision: response.decision,
                },
            };
        }
        if (
            response.type === "user_question"
            && response.outcome === "selected"
            && isRequestId(response.choiceId)
        ) {
            return {
                type: "ui_response",
                requestId: command.requestId,
                response: {
                    type: "user_question",
                    outcome: "selected",
                    choiceId: response.choiceId,
                    ...(typeof response.notes === "string"
                            && response.notes.trim().length > 0
                        ? { notes: response.notes.trim() }
                        : {}),
                },
            };
        }
        if (
            response.type === "user_question"
            && response.outcome === "cancelled"
        ) {
            return {
                type: "ui_response",
                requestId: command.requestId,
                response: {
                    type: "user_question",
                    outcome: "cancelled",
                },
            };
        }
        if (
            response.type === "user_question"
            && response.outcome === "custom"
            && typeof response.text === "string"
            && response.text.trim().length > 0
        ) {
            return {
                type: "ui_response",
                requestId: command.requestId,
                response: {
                    type: "user_question",
                    outcome: "custom",
                    text: response.text.trim(),
                },
            };
        }
        if (
            response.type === "configuration_required"
            && (
                response.outcome === "configured"
                || response.outcome === "cancelled"
                || response.outcome === "unavailable"
            )
        ) {
            return {
                type: "ui_response",
                requestId: command.requestId,
                response: {
                    type: "configuration_required",
                    outcome: response.outcome,
                },
            };
        }
    }
    if (
        command.type === "get_model_settings"
        && isRequestId(command.requestId)
    ) {
        return {
            type: "get_model_settings",
            requestId: command.requestId,
        };
    }
    if (
        (command.type === "update_model_settings"
            || command.type === "update_session_model_settings")
        && isRequestId(command.requestId)
    ) {
        const patch = parseModelSettingsPatch(command.patch);
        if (patch !== undefined) {
            return {
                type: command.type,
                requestId: command.requestId,
                patch,
            };
        }
    }
    if (
        command.type === "wear_agent"
        && isRequestId(command.requestId)
        && isNonEmptyString(command.name)
    ) {
        return {
            type: "wear_agent",
            requestId: command.requestId,
            name: command.name,
        };
    }
    if (command.type === "list_agents" && isRequestId(command.requestId)) {
        return { type: "list_agents", requestId: command.requestId };
    }
    if (command.type === "list_skills" && isRequestId(command.requestId)) {
        return { type: "list_skills", requestId: command.requestId };
    }
    if (
        command.type === "invoke_skill"
        && isRequestId(command.requestId)
        && typeof command.name === "string"
        && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.name)
        && typeof command.argumentsText === "string"
    ) {
        return {
            type: "invoke_skill",
            requestId: command.requestId,
            name: command.name,
            argumentsText: command.argumentsText,
        };
    }
    if (
        command.type === "update_agent_default_pair"
        && isRequestId(command.requestId)
        && isNonEmptyString(command.name)
        && (command.pair === null
            || (typeof command.pair === "object"
                && command.pair !== null
                && isNonEmptyString(Reflect.get(command.pair, "name"))
                && (Reflect.get(command.pair, "effort") === undefined
                    || isNonEmptyString(Reflect.get(command.pair, "effort")))))
    ) {
        return {
            type: "update_agent_default_pair",
            requestId: command.requestId,
            name: command.name,
            pair: command.pair === null ? null : {
                name: Reflect.get(command.pair, "name") as string,
                ...(Reflect.get(command.pair, "effort") === undefined ? {} : {
                    effort: Reflect.get(command.pair, "effort") as string,
                }),
            },
        };
    }
    if (
        command.type === "get_session_model_settings_history"
        && isRequestId(command.requestId)
    ) {
        return {
            type: "get_session_model_settings_history",
            requestId: command.requestId,
        };
    }
    if (
        command.type === "update_session_permission_mode"
        && isRequestId(command.requestId)
        && isApprovalMode(command.mode)
    ) {
        return {
            type: "update_session_permission_mode",
            requestId: command.requestId,
            mode: command.mode,
        };
    }
    if (command.type === "oneshot" && isRequestId(command.requestId)) {
        const parsed = parseOneshotCommand(command, command.requestId);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    if (
        command.type === "catalog_refresh"
        && isRequestId(command.requestId)
        && isNonEmptyString(command.provider)
    ) {
        return {
            type: "catalog_refresh",
            requestId: command.requestId,
            provider: command.provider,
        };
    }
    if (
        (command.type === "pool_add" || command.type === "pool_remove")
        && isRequestId(command.requestId)
        && isNonEmptyString(command.provider)
        && isNonEmptyString(command.model)
    ) {
        return {
            type: command.type,
            requestId: command.requestId,
            provider: command.provider,
            model: command.model,
            ...(command.type === "pool_add" && command.verify === true
                ? { verify: true }
                : {}),
        };
    }
    if (
        command.type === "pool_move"
        && isRequestId(command.requestId)
        && isNonEmptyString(command.provider)
        && isNonEmptyString(command.model)
        && typeof command.delta === "number"
        && Number.isInteger(command.delta)
    ) {
        return {
            type: "pool_move",
            requestId: command.requestId,
            provider: command.provider,
            model: command.model,
            delta: command.delta,
        };
    }
    if (
        command.type === "pool_name"
        && isRequestId(command.requestId)
        && isNonEmptyString(command.provider)
        && isNonEmptyString(command.model)
        && (command.name === null || isNonEmptyString(command.name))
    ) {
        return {
            type: "pool_name",
            requestId: command.requestId,
            provider: command.provider,
            model: command.model,
            name: command.name as string | null,
        };
    }
    if (command.type === "get_permissions" && isRequestId(command.requestId)) {
        return {
            type: "get_permissions",
            requestId: command.requestId,
        };
    }
    if (
        command.type === "update_permissions"
        && isRequestId(command.requestId)
        && isApprovalMode(command.mode)
    ) {
        return {
            type: "update_permissions",
            requestId: command.requestId,
            mode: command.mode,
        };
    }
    if (
        command.type === "add_permission_preference"
        && isRequestId(command.requestId)
        && isPermissionPredicate(command.when)
    ) {
        return {
            type: "add_permission_preference",
            requestId: command.requestId,
            when: command.when,
        };
    }
    if (
        command.type === "remove_permission_grant"
        && isRequestId(command.requestId)
        && typeof command.id === "string"
        && command.id.length > 0
    ) {
        return {
            type: "remove_permission_grant",
            requestId: command.requestId,
            id: command.id,
        };
    }
    if (
        command.type === "remove_permission_preference"
        && isRequestId(command.requestId)
        && typeof command.id === "string"
        && command.id.length > 0
    ) {
        return {
            type: "remove_permission_preference",
            requestId: command.requestId,
            id: command.id,
        };
    }
    if (
        command.type === "update_session_name"
        && isRequestId(command.requestId)
        && (typeof command.name === "string" || command.name === null)
    ) {
        return {
            type: "update_session_name",
            requestId: command.requestId,
            name: command.name,
        };
    }
    if (command.type === "compact" && isRequestId(command.requestId)) {
        return { type: "compact", requestId: command.requestId };
    }
    if (command.type === "list_timeline" && isRequestId(command.requestId)) {
        return {
            type: "list_timeline",
            requestId: command.requestId,
        };
    }
    if (
        command.type === "preview_timeline_action"
        && isRequestId(command.requestId)
        && isRequestId(command.boundaryId)
        && command.action === "rewind_conversation"
    ) {
        return {
            type: "preview_timeline_action",
            requestId: command.requestId,
            boundaryId: command.boundaryId,
            action: "rewind_conversation",
        };
    }
    if (
        command.type === "apply_timeline_action"
        && isRequestId(command.requestId)
        && isRequestId(command.planId)
    ) {
        return {
            type: "apply_timeline_action",
            requestId: command.requestId,
            planId: command.planId,
        };
    }
    return undefined;
}

export function isTimelineCommand(
    command: ClientCommand,
): command is TimelineCommand {
    return command.type === "list_timeline"
        || command.type === "preview_timeline_action"
        || command.type === "apply_timeline_action";
}

export function isTimelineReplyUpdate(
    update: AgentUpdate,
): update is TimelineReplyUpdate {
    return update.type === "timeline"
        || update.type === "timeline_action_preview"
        || update.type === "timeline_action_applied"
        || update.type === "timeline_action_rejected";
}

export function isOneshotReplyUpdate(
    update: AgentUpdate,
): update is OneshotResultUpdate | OneshotRejectedUpdate {
    return update.type === "oneshot_result"
        || update.type === "oneshot_rejected";
}

export function isSessionNameReplyUpdate(
    update: AgentUpdate,
): update is SessionNameReplyUpdate {
    return update.type === "session_name"
        || update.type === "session_name_rejected";
}

function parseModelSettingsPatch(
    value: unknown,
): ModelSettingsPatch | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const source = value as Record<string, unknown>;
    const hasModel = Object.hasOwn(source, "model");
    const hasProvider = Object.hasOwn(source, "provider");
    const hasReasoningEffort = Object.hasOwn(source, "reasoningEffort");
    const hasContextLimit = Object.hasOwn(source, "contextLimit");
    const hasReviewer = Object.hasOwn(source, "reviewer");
    const hasDeveloper = Object.hasOwn(source, "developer");
    if (
        (!hasProvider && !hasModel && !hasReasoningEffort && !hasContextLimit
            && !hasReviewer && !hasDeveloper)
        || (hasProvider
            && (typeof source.provider !== "string"
                || source.provider.trim().length === 0))
        || (hasModel
            && (typeof source.model !== "string"
                || source.model.trim().length === 0))
        || (hasReasoningEffort
            && source.reasoningEffort !== null
            && !isModelReasoningEffort(source.reasoningEffort))
        || (hasContextLimit
            && source.contextLimit !== null
            && (!Number.isSafeInteger(source.contextLimit)
                || (source.contextLimit as number) <= 0))
        || (hasReviewer
            && source.reviewer !== null
            && !isReviewerSettingsPatch(source.reviewer))
        || (hasDeveloper
            && source.developer !== null
            && !isDeveloperSettingsPatch(source.developer))
    ) {
        return undefined;
    }
    const provider = hasProvider ? source.provider as string : undefined;
    const model = hasModel ? source.model as string : undefined;
    const reasoningEffort = hasReasoningEffort
        ? source.reasoningEffort as ModelReasoningEffort | null
        : undefined;
    const contextLimit = hasContextLimit
        ? source.contextLimit as number | null
        : undefined;
    return {
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(contextLimit === undefined ? {} : { contextLimit }),
        ...(hasDeveloper
            ? {
                developer: source.developer as
                    | DeveloperSettingsPatch
                    | null,
            }
            : {}),
        ...(!hasReviewer ? {} : {
            reviewer: source.reviewer as ReviewerSettingsPatch | null,
        }),
    };
}

function isRequestId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isAttachmentIds(value: unknown): value is readonly string[] | undefined {
    return value === undefined || (
        Array.isArray(value)
        && value.every((id) => typeof id === "string" && id.length > 0)
    );
}

function isModelReasoningEffort(
    value: unknown,
): value is ModelReasoningEffort {
    return typeof value === "string" && value.length > 0;
}

export function createProtocolEncoder(
    sender: AgentUpdateSender,
    attachmentName?: AttachmentNameLookup,
    harnessMessages: () => readonly {
        readonly afterMessage: number;
        readonly text: string;
        readonly tone: "primary" | "soft" | "error";
    }[] = () => [],
    replayContextCapacity: (
        provider: string,
        model: string,
    ) => number | undefined = () => undefined,
): ProtocolEncoder {
    let seq = 0;
    let sessionUsage: SessionModelUsage = { rows: [] };
    let measuredCapacity: number | undefined;
    let measuredContext: ContextMeasurement | undefined;
    let measuredModel: string | undefined;
    let pendingCheckpointFloor: ContextMeasurement | undefined;
    let promptQueue: PromptQueueState | undefined;

    const encode = (event: Parameters<EngineEventSubscriber>[0]): void => {
        if (event.type === "prompt_queue_changed") {
            promptQueue = structuredClone(event.queue);
            seq += 1;
            sender.send({
                type: "prompt_queue",
                queue: structuredClone(event.queue),
                seq,
            });
            return;
        }
        if (event.type === "turn_started") {
            seq += 1;
            sender.send({
                type: "user_prompt",
                content: textContent(event.message.content),
                ...attachmentRefs(event.message.content, attachmentName),
                seq,
            });
            return;
        }
        if (event.type === "delivery_turn_started") {
            seq += 1;
            sender.send({
                type: "status",
                state: "working",
                seq,
            });
            return;
        }
        if (event.type === "task_notification") {
            seq += 1;
            sender.send({
                type: "task_notification",
                deliveryId: event.deliveryId,
                sourceAgentId: event.sourceAgentId,
                content: event.content,
                ...(event.kind === undefined ? {} : { kind: event.kind }),
                seq,
            });
            return;
        }
        if (event.type === "notice") {
            seq += 1;
            sender.send({
                type: "notice",
                key: event.key,
                count: event.count,
                seq,
            });
            return;
        }
        if (
            event.type === "model_stream"
            && event.event.type === "text_delta"
        ) {
            seq += 1;
            sender.send({
                type: "assistant_delta",
                text: event.event.text,
                seq,
            });
            return;
        }

        if (
            event.type === "model_stream"
            && event.event.type === "thinking_delta"
        ) {
            seq += 1;
            sender.send({
                type: "assistant_thinking",
                text: event.event.text,
                seq,
            });
            return;
        }

        if (event.type === "tool_execution_started") {
            seq += 1;
            sender.send({
                type: "tool_started",
                tool: event.toolCall.name,
                args: event.toolCall.input,
                seq,
            });
            return;
        }

        if (event.type === "tool_review_decided") {
            seq += 1;
            sender.send({
                type: "tool_review",
                tool: event.toolCall.name,
                decision: event.decision,
                reason: event.reason,
                riskLevel: event.riskLevel,
                userAuthorization: event.userAuthorization,
                seq,
            });
            return;
        }

        if (event.type === "tool_breaker_tripped") {
            seq += 1;
            sender.send({
                type: "tool_breaker_tripped",
                tool: event.tool,
                denials: event.denials,
                action: event.action,
                seq,
            });
            return;
        }

        if (event.type === "tool_execution_finished") {
            seq += 1;
            sender.send({
                type: "tool_finished",
                tool: event.toolCall.name,
                output: textContent(event.result.content),
                isError: event.result.isError,
                ...(event.result.processId === undefined
                    ? {}
                    : { processId: event.result.processId }),
                seq,
            });
            return;
        }
        if (event.type === "tool_presentation_ready") {
            seq += 1;
            sender.send({
                type: "tool_presentation",
                tool: event.tool,
                presentation: event.presentation,
                seq,
            });
            return;
        }

        if (event.type === "ui_request") {
            seq += 1;
            if (event.request.type === "tool_approval") {
                sender.send({
                    type: "ui_request",
                    requestId: event.requestId,
                    request: event.request,
                    seq,
                });
            } else if (event.request.type === "user_question") {
                sender.send({
                    type: "ui_request",
                    requestId: event.requestId,
                    request: event.request,
                    seq,
                });
            } else {
                sender.send({
                    type: "ui_request",
                    requestId: event.requestId,
                    request: event.request,
                    seq,
                });
            }
            return;
        }

        if (event.type === "ui_request_closed") {
            seq += 1;
            sender.send({
                type: "ui_request_closed",
                requestId: event.requestId,
                seq,
            });
            return;
        }

        if (event.type === "model_settings_changed") {
            seq += 1;
            sender.send({
                type: "model_settings",
                requestId: event.requestId,
                settings: event.settings,
                pending: event.pending,
                ...(event.updatedDefaults === true
                    ? { updatedDefaults: true as const }
                    : {}),
                ...(event.updatedSession === true
                    ? { updatedSession: true as const }
                    : {}),
                ...(event.origin === undefined ? {} : { origin: event.origin }),
                seq,
            });
            return;
        }

        if (event.type === "agent_worn") {
            seq += 1;
            sender.send({ type: "agent_worn", ...event.update, seq });
            return;
        }

        if (event.type === "agent_catalog") {
            seq += 1;
            sender.send({ type: "agent_catalog", ...event.update, seq });
            return;
        }

        if (event.type === "agent_rejected") {
            seq += 1;
            sender.send({
                type: "agent_rejected",
                requestId: event.requestId,
                reason: event.reason,
                seq,
            });
            return;
        }

        if (event.type === "skill_catalog") {
            seq += 1;
            sender.send({
                type: "skill_catalog",
                requestId: event.requestId,
                skills: event.skills,
                warnings: event.warnings,
                seq,
            });
            return;
        }

        if (event.type === "skill_invocation_accepted") {
            seq += 1;
            sender.send({
                type: "skill_invocation_accepted",
                requestId: event.requestId,
                name: event.name,
                prompt: event.prompt,
                queued: event.queued,
                seq,
            });
            return;
        }

        if (event.type === "skill_invocation_rejected") {
            seq += 1;
            sender.send({
                type: "skill_invocation_rejected",
                requestId: event.requestId,
                name: event.name,
                reason: event.reason,
                seq,
            });
            return;
        }

        if (event.type === "session_model_settings_history") {
            seq += 1;
            sender.send({
                type: "session_model_settings_history",
                requestId: event.requestId,
                entries: event.entries,
                seq,
            });
            return;
        }

        if (event.type === "model_settings_rejected") {
            seq += 1;
            sender.send({
                type: "model_settings_rejected",
                requestId: event.requestId,
                reason: event.reason,
                seq,
            });
            return;
        }

        if (event.type === "pool_admission_progress") {
            seq += 1;
            sender.send({
                type: "pool_admission_progress",
                requestId: event.requestId,
                step: event.step,
                label: event.label,
                status: event.status,
                ...(event.detail === undefined ? {} : { detail: event.detail }),
                seq,
            });
            return;
        }

        if (event.type === "pool_admission_result") {
            seq += 1;
            sender.send({
                type: "pool_admission_result",
                requestId: event.requestId,
                provider: event.provider,
                model: event.model,
                verdict: event.verdict,
                ...(event.reason === undefined ? {} : { reason: event.reason }),
                ...(event.statusCode === undefined
                    ? {}
                    : { statusCode: event.statusCode }),
                seq,
            });
            return;
        }

        if (event.type === "permissions_changed") {
            seq += 1;
            sender.send({
                type: "permissions",
                requestId: event.requestId,
                mode: event.mode,
                pending: event.pending,
                ...(event.inspection === undefined
                    ? {}
                    : { inspection: event.inspection }),
                ...(event.origin === undefined ? {} : { origin: event.origin }),
                seq,
            });
            return;
        }

        if (event.type === "permissions_rejected") {
            seq += 1;
            sender.send({
                type: "permissions_rejected",
                requestId: event.requestId,
                reason: event.reason,
                seq,
            });
            return;
        }

        if (event.type === "context_measured") {
            measuredModel = event.model;
            measuredCapacity = event.measurement.capacity;
            measuredContext = event.measurement;
            seq += 1;
            sender.send({
                type: "context",
                measurement: event.measurement,
                seq,
            });
        }

        if (event.type === "model_retry_scheduled") {
            seq += 1;
            sender.send({
                type: "model_activity",
                phase: "retrying",
                model: event.model,
                nextAttempt: event.nextAttempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                retryAt: new Date(Date.now() + event.delayMs).toISOString(),
                failure: {
                    kind: event.failure.kind,
                    ...(event.failure.statusCode === undefined
                        ? {}
                        : { statusCode: event.failure.statusCode }),
                },
                ...(event.replacesPartialAttempt === true
                    ? { replacesPartialAttempt: true as const }
                    : {}),
                seq,
            });
        }

        if (event.type === "model_fallback_selected") {
            seq += 1;
            sender.send({
                type: "model_substitution",
                model: event.fromModel,
                requested: event.fromModel,
                using: event.toModel,
                reason: event.failure.message,
                scope: "model",
                source: "turn",
                seq,
            });
        }

        if (event.type === "model_effort_coarsened") {
            seq += 1;
            sender.send({
                type: "model_substitution",
                model: event.model,
                requested: event.requested,
                ...(event.using === undefined ? {} : { using: event.using }),
                reason: event.reason,
                scope: "effort",
                source: "turn",
                seq,
            });
        }

        if (event.type === "model_substituted") {
            seq += 1;
            sender.send({
                type: "model_substitution",
                ...event.substitution,
                source: "subagent",
                seq,
            });
        }

        if (event.type === "compaction_started") {
            seq += 1;
            sender.send({
                type: "compaction",
                phase: "started",
                strategy: event.strategy,
                ...(event.provider === undefined
                    ? {}
                    : { provider: event.provider }),
                ...(event.model === undefined ? {} : { model: event.model }),
                ...(event.warning === undefined
                    ? {}
                    : { warning: event.warning }),
                seq,
            });
        }

        if (event.type === "compaction_finished") {
            seq += 1;
            sender.send({
                type: "compaction",
                phase: "finished",
                strategy: event.strategy,
                ...(event.provider === undefined
                    ? {}
                    : { provider: event.provider }),
                ...(event.model === undefined ? {} : { model: event.model }),
                outcome: event.outcome,
                ...(event.stoppedWithTurn === undefined
                    ? {}
                    : { stoppedWithTurn: event.stoppedWithTurn }),
                ...(event.reason === undefined ? {} : { reason: event.reason }),
                ...(event.before === undefined ? {} : { before: event.before }),
                ...(event.after === undefined ? {} : { after: event.after }),
                seq,
            });
        }

        if (event.type === "turn_finished") {
            sessionUsage = addSessionModelUsage(sessionUsage, event.message);
            // The provider counted the request the engine had only estimated,
            // so the turn ends on the authoritative number rather than leaving
            // the estimate standing as the last word. The window is the one
            // that request was measured against; re-deriving it from the
            // catalog would drop a locally discovered model's.
            const reportedRequest = reportedMeasurement(
                event.message,
                event.message.source.model === measuredModel
                    ? measuredCapacity
                    : undefined,
            );
            if (reportedRequest !== undefined) {
                // Provider usage covers the request before this assistant
                // message existed. Add the completed response before calling
                // the number current context, and retain a larger projection:
                // correcting a coarse estimate must not make context appear to
                // disappear merely because the turn finished.
                const reportedNextContext = reportedRequest.tokens
                    + measureCompletedAssistant(event.message);
                const tokens = Math.max(
                    measuredContext?.tokens ?? 0,
                    reportedNextContext,
                );
                const projection = completedContextProjection(
                    measuredContext?.projection,
                    reportedRequest.tokens,
                    reportedNextContext,
                    tokens,
                );
                const measurement: ContextMeasurement = {
                    tokens,
                    ...(reportedRequest.capacity === undefined
                        ? {}
                        : { capacity: reportedRequest.capacity }),
                    estimated: true,
                    ...(projection === undefined ? {} : { projection }),
                    ...(measuredContext?.compaction === undefined
                        ? {}
                        : { compaction: measuredContext.compaction }),
                };
                measuredContext = measurement;
                pendingCheckpointFloor = measurement;
                seq += 1;
                sender.send({ type: "context", measurement, seq });
            }
            seq += 1;
            const outcome = terminalOutcome(event.message);
            const error = terminalDetail(event.message);
            sender.send({
                type: "turn_finished",
                ...(outcome === undefined ? {} : { outcome }),
                ...(error === undefined ? {} : { error }),
                ...(isEmptyAssistantMessage(event.message)
                    ? { empty: true as const }
                    : {}),
                usage: sessionUsage,
                seq,
            });
        }
    };

    return Object.assign(encode, {
        checkpoint(
            messages: readonly ModelMessage[],
            messageIds?: MessageIdLookup,
            checkpointContext?: ContextMeasurement,
            recipe?: ContextMeasurement,
        ): void {
            const restored = latestMeasurement(
                messages,
                measuredModel,
                measuredCapacity,
                replayContextCapacity,
            );
            const floor = pendingCheckpointFloor;
            pendingCheckpointFloor = undefined;
            // Occupancy can be rebuilt from provider usage. The last request
            // recipe cannot: keep it from this encoder and stretch it to the
            // headline so BREAKDOWN still names the files after reconnect.
            const headline = checkpointContext
                ?? (restored === undefined
                    ? floor
                    : floor !== undefined
                        && floor.capacity === restored.capacity
                        ? {
                            ...restored,
                            tokens: Math.max(
                                restored.tokens,
                                floor.tokens,
                            ),
                            estimated: true,
                            ...(floor.compaction === undefined
                                ? {}
                                : { compaction: floor.compaction }),
                        }
                        : restored);
            const context = coherentContextMeasurement(
                keepLastRequestRecipe(
                    headline,
                    recipe ?? measuredContext ?? floor,
                ),
            );
            if (recipe !== undefined) {
                measuredContext = context;
            }
            sessionUsage = summarizeSessionModelUsage(messages);
            sender.send({
                type: "history",
                entries: projectTranscript(
                    messages,
                    attachmentName,
                    messageIds,
                    harnessMessages(),
                ),
                ...(context === undefined ? {} : { context }),
                usage: sessionUsage,
                ...(promptQueue === undefined
                    ? {}
                    : { promptQueue: structuredClone(promptQueue) }),
                seq,
            });
        },
        restoreContext(measurement?: ContextMeasurement): void {
            measuredContext = measurement;
            pendingCheckpointFloor = undefined;
        },
    });
}

export function summarizeSessionModelUsage(
    messages: readonly ModelMessage[],
): SessionModelUsage {
    return messages.reduce(
        (usage, message) => message.role === "assistant"
            ? addSessionModelUsage(usage, message)
            : usage,
        { rows: [] } as SessionModelUsage,
    );
}

function addSessionModelUsage(
    usage: SessionModelUsage,
    message: AssistantMessage,
): SessionModelUsage {
    const key = `${message.source.provider}\0${message.source.model}`;
    const rows = [...usage.rows];
    const index = rows.findIndex((row) =>
        `${row.provider}\0${row.model}` === key
    );
    const prior = rows[index];
    const next: SessionModelUsageRow = {
        provider: message.source.provider,
        model: message.source.model,
        calls: (prior?.calls ?? 0) + 1,
        durationMs: (prior?.durationMs ?? 0) + (message.durationMs ?? 0),
        inputTokens: (prior?.inputTokens ?? 0) + message.usage.inputTokens,
        outputTokens: (prior?.outputTokens ?? 0) + message.usage.outputTokens,
        cachedInputTokens: (prior?.cachedInputTokens ?? 0)
            + message.usage.cachedInputTokens,
        reasoningTokens: (prior?.reasoningTokens ?? 0)
            + message.usage.reasoningTokens,
        totalTokens: (prior?.totalTokens ?? 0) + message.usage.totalTokens,
        ...(message.usage.cost === undefined && prior?.cost === undefined
            ? {}
            : { cost: (prior?.cost ?? 0) + (message.usage.cost ?? 0) }),
        callsWithoutCost: (prior?.callsWithoutCost ?? 0)
            + (message.usage.cost === undefined ? 1 : 0),
    };
    if (index < 0) rows.push(next);
    else rows[index] = next;
    return { rows };
}

/**
 * A reconnecting client needs a number before the next turn produces one, and
 * the last response's usage is the baseline that survives a restart. Its
 * response and everything appended afterward belong to the next request too.
 * A capacity measured this session is preferred over the catalog's, which has
 * no entry for a locally served model.
 */
function latestMeasurement(
    messages: readonly ModelMessage[],
    measuredModel?: string,
    capacity?: number,
    replayContextCapacity: (
        provider: string,
        model: string,
    ) => number | undefined = () => undefined,
): ContextMeasurement | undefined {
    // The last assistant is not always the last one a provider counted: an
    // aborted turn and a synthetic terminal message both end the transcript
    // with a response carrying no usage, and stopping there would replay a
    // session that had a measurement as one that never had one.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined || message.role !== "assistant") {
            continue;
        }
        const measurement = reportedMeasurement(
            message,
            message.source.model === measuredModel
                ? capacity
                : replayContextCapacity(
                    message.source.provider,
                    message.source.model,
                ),
        );
        if (measurement !== undefined) {
            return {
                tokens: measurement.tokens
                    + measureCompletedAssistant(message)
                    + measureMessages(messages.slice(index + 1)),
                ...(measurement.capacity === undefined
                    ? {}
                    : { capacity: measurement.capacity }),
                estimated: true,
            };
        }
    }
    return undefined;
}

/**
 * A projection describes one exact request. If the headline token count
 * moved, stretch the named parts to that count rather than dropping them:
 * `/context` still needs the files, and the used total is already marked
 * estimated.
 */
function coherentContextMeasurement(
    measurement: ContextMeasurement | undefined,
): ContextMeasurement | undefined {
    if (measurement?.projection === undefined) {
        return measurement;
    }
    const projection = scaleProjectionTo(
        measurement.projection,
        measurement.tokens,
    );
    return projection === measurement.projection
        ? measurement
        : { ...measurement, projection };
}

/**
 * Headline occupancy may come from provider usage; the recipe is only in
 * the last measurement. Overlay that recipe without changing the count.
 */
function keepLastRequestRecipe(
    headline: ContextMeasurement | undefined,
    recipe: ContextMeasurement | undefined,
): ContextMeasurement | undefined {
    if (headline === undefined) return recipe;
    const projection = recipe?.projection ?? headline.projection;
    const compaction = recipe?.compaction ?? headline.compaction;
    return {
        ...headline,
        ...(compaction === undefined ? {} : { compaction }),
        ...(projection === undefined ? {} : { projection }),
    };
}

function completedContextProjection(
    projection: ContextMeasurement["projection"],
    reportedRequestTokens: number,
    reportedNextContext: number,
    tokens: number,
): ContextMeasurement["projection"] {
    if (projection === undefined) return undefined;
    const messageIndexes = projection.components.flatMap((component) => {
        const match = /^message:(\d+)$/.exec(component.id);
        return match === null ? [] : [Number(match[1])];
    });
    const responseTokens = reportedNextContext - reportedRequestTokens;
    if (
        projection.estimatedTokens === reportedRequestTokens
        && tokens === reportedNextContext
    ) {
        return {
            estimatedTokens: reportedNextContext,
            components: [
                ...projection.components,
                {
                    kind: "message",
                    id: `message:${Math.max(0, ...messageIndexes) + 1}`,
                    owner: "session",
                    source: "assistant",
                    displayName: "assistant message",
                    count: 1,
                    estimatedTokens: responseTokens,
                },
            ],
        };
    }
    return scaleProjectionTo(projection, tokens);
}

function reportedMeasurement(
    message: ModelMessage,
    capacity?: number,
): ContextMeasurement | undefined {
    if (message.role !== "assistant") {
        return undefined;
    }
    return measureReportedUsage(
        message.usage,
        capacity
            ?? contextWindowForModel(message.source.provider, message.source.model),
    );
}

/**
 * A turn that produced nothing: no tool call, no visible text, and no
 * reasoning. A turn that reasoned and then said nothing is a failure instead,
 * and carries `stopReason: "error"` by the time it reaches here.
 */
export function isEmptyAssistantMessage(message: ModelMessage): boolean {
    return message.role === "assistant"
        && message.stopReason === "stop"
        && !message.content.some((content) =>
            content.type === "tool_call"
            || ((content.type === "text" || content.type === "thinking")
                && content.text.length > 0)
        );
}

/**
 * Maps a projected message back to the ID of the stored record it came from.
 * Keyed by object identity rather than position so a caller cannot silently
 * misalign the two lists.
 */
export type MessageIdLookup = ReadonlyMap<ModelMessage, string>;

export function projectTranscript(
    messages: readonly ModelMessage[],
    attachmentName?: AttachmentNameLookup,
    messageIds?: MessageIdLookup,
    harnessMessages: readonly {
        readonly afterMessage: number;
        readonly text: string;
        readonly tone: "primary" | "soft" | "error";
    }[] = [],
): readonly TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    const appendHarnessMessages = (afterMessage: number): void => {
        for (const message of harnessMessages) {
            if (message.afterMessage === afterMessage) {
                entries.push({
                    kind: "harness",
                    text: message.text,
                    tone: message.tone,
                });
            }
        }
    };

    appendHarnessMessages(0);
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        const messageId = messageIds?.get(message);
        let subIndex = 0;
        const push = (entry: TranscriptEntry): void => {
            entries.push(
                messageId === undefined
                    ? entry
                    : { ...entry, id: `${messageId}#${subIndex++}` },
            );
        };
        if (message.internal === true) {
            appendHarnessMessages(index + 1);
            continue;
        }
        if (message.role === "user") {
            push({
                kind: "user",
                text: textContent(message.content),
                ...attachmentRefs(message.content, attachmentName),
            });
            appendHarnessMessages(index + 1);
            continue;
        }
        if (message.role === "tool_result") {
            push({
                kind: "tool_result",
                tool: message.toolName,
                output: textContent(message.content),
                isError: message.isError,
                ...(message.processId === undefined
                    ? {}
                    : { processId: message.processId }),
            });
            if (message.presentation !== undefined) {
                push({
                    kind: "presentation",
                    presentation: structuredClone(message.presentation),
                });
            }
            appendHarnessMessages(index + 1);
            continue;
        }
        // Ahead of the message's own content: the substitution is the reason
        // this content came from where it did.
        for (const substitution of message.substitutions ?? []) {
            push({
                kind: "model_substitution",
                substitution: { ...substitution },
            });
        }
        if (isEmptyAssistantMessage(message)) {
            push({ kind: "empty" });
            appendHarnessMessages(index + 1);
            continue;
        }
        for (const content of message.content) {
            if (content.type === "text" && content.text.length > 0) {
                push({ kind: "assistant", text: content.text });
            }
            if (content.type === "tool_call") {
                push({
                    kind: "tool",
                    tool: content.name,
                    args: structuredClone(content.input),
                });
            }
        }
        const outcome = terminalOutcome(message);
        if (outcome !== undefined) {
            const detail = outcome === "aborted"
                ? undefined
                : terminalDetail(message);
            push({
                kind: "error",
                outcome,
                ...(detail === undefined ? {} : { detail }),
            });
        }
        appendHarnessMessages(index + 1);
    }

    return entries;
}

function terminalOutcome(
    message: ModelMessage,
): "error" | "aborted" | undefined {
    if (message.role !== "assistant") {
        return undefined;
    }
    return message.stopReason === "error" || message.stopReason === "aborted"
        ? message.stopReason
        : undefined;
}

function terminalDetail(message: ModelMessage): string | undefined {
    if (message.role !== "assistant") {
        return undefined;
    }
    const detail = message.errorMessage?.trim();
    if (detail !== undefined && detail.length > 0) {
        return detail;
    }
    return undefined;
}

function textContent(
    content: readonly { readonly type: string; readonly text?: string }[],
): string {
    return content.flatMap((part) => part.type === "text" && part.text !== undefined
        ? [part.text]
        : []).join("\n");
}

export function attachmentRefs(
    content: readonly { readonly type: string; readonly attachmentId?: string }[],
    attachmentName?: AttachmentNameLookup,
): { readonly attachments?: readonly AttachmentRef[] } {
    const refs = content.flatMap((part) => {
        if (part.type !== "image_attachment" || part.attachmentId === undefined) {
            return [];
        }
        const name = attachmentName?.(part.attachmentId);
        return [{
            id: part.attachmentId,
            ...(name === undefined ? {} : { name }),
        }];
    });
    return refs.length === 0 ? {} : { attachments: refs };
}

/** Caps the conversation a oneshot may carry, so one call cannot ship a whole session. */
const ONESHOT_MAX_MESSAGES = 200;

function parseOneshotCommand(
    command: Record<string, unknown>,
    requestId: string,
): OneshotCommand | undefined {
    const model = command.model;
    if (typeof model !== "string" || model.trim().length === 0) {
        return undefined;
    }
    const messages = parseOneshotMessages(command.messages);
    if (messages === undefined) {
        return undefined;
    }
    const provider = command.provider;
    const reasoningEffort = command.reasoningEffort;
    const systemPrompt = command.systemPrompt;
    const maxTokens = command.maxTokens;
    if (
        (provider !== undefined && typeof provider !== "string")
        || (reasoningEffort !== undefined && typeof reasoningEffort !== "string")
        || (systemPrompt !== undefined && typeof systemPrompt !== "string")
        || (maxTokens !== undefined
            && (typeof maxTokens !== "number" || !Number.isInteger(maxTokens)
                || maxTokens < 1))
    ) {
        return undefined;
    }
    return {
        type: "oneshot",
        requestId,
        model,
        messages,
        ...(provider === undefined ? {} : { provider }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
    };
}

function parseOneshotMessages(
    value: unknown,
): readonly OneshotMessage[] | undefined {
    if (
        !Array.isArray(value) || value.length === 0
        || value.length > ONESHOT_MAX_MESSAGES
    ) {
        return undefined;
    }
    const messages: OneshotMessage[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) {
            return undefined;
        }
        const role = Reflect.get(entry, "role");
        const content = Reflect.get(entry, "content");
        if (
            (role !== "user" && role !== "assistant")
            || typeof content !== "string"
        ) {
            return undefined;
        }
        messages.push({ role, content });
    }
    return messages;
}
