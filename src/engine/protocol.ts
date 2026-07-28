import type {
    EngineEventSubscriber,
    ToolApprovalUiRequest,
    UiResponse,
    UserQuestionUiRequest,
} from "./events.ts";
import type {
    ModelMessage,
    ModelReasoningEffort,
    ToolPresentation,
} from "../model/types.ts";
import type {
    ModelSettingsPatch,
    ModelTurnSettings,
} from "./model-settings.ts";
import { contextWindowForModel } from "./model-settings.ts";
import {
    measureReportedUsage,
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
    readonly kind: "user";
    readonly text: string;
    readonly attachments?: readonly AttachmentRef[];
}

export interface AssistantTranscriptEntry {
    readonly kind: "assistant";
    readonly text: string;
}

export interface ToolTranscriptEntry {
    readonly kind: "tool";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}

export interface PresentationTranscriptEntry {
    readonly kind: "presentation";
    readonly presentation: ToolPresentation;
}

export interface ErrorTranscriptEntry {
    readonly kind: "error";
    readonly detail?: string;
}

/**
 * A turn that ended with nothing to show. Silence and a stalled client look the
 * same in a transcript, so the absence is written down rather than left blank.
 */
export interface EmptyTranscriptEntry {
    readonly kind: "empty";
}

export type TranscriptEntry =
    | UserTranscriptEntry
    | AssistantTranscriptEntry
    | ToolTranscriptEntry
    | PresentationTranscriptEntry
    | ErrorTranscriptEntry
    | EmptyTranscriptEntry;

export interface PromptCommand {
    readonly type: "prompt";
    readonly content: string;
    readonly attachmentIds?: readonly string[];
}

export interface AttachImageCommand {
    readonly type: "attach_image";
    readonly requestId: string;
    readonly path: string;
}

export interface AbortCommand {
    readonly type: "abort";
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
 * Keeping a model is not choosing one, so this is its own command rather than
 * a field on `update_model_settings`: pinning a model the user is only
 * looking at must not switch the turn to it. The reply is the same
 * `model_settings_changed` update, because that update already carries the
 * pin list and a client would otherwise have to ask again to see its own edit.
 */
export interface UpdatePinCommand {
    readonly type: "update_pin";
    readonly requestId: string;
    readonly action: "add" | "remove";
    readonly provider: string;
    readonly model: string;
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
    | AttachImageCommand
    | AbortCommand
    | UiResponseCommand
    | GetModelSettingsCommand
    | UpdateModelSettingsCommand
    | UpdatePinCommand
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
    readonly context?: ContextMeasurement;
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

/**
 * Compaction starting and ending. The transcript is unchanged either way, so
 * without this a client would see the context number drop between turns with
 * nothing to attribute it to, and a failed compaction would be silent.
 */
export interface CompactionUpdate {
    readonly type: "compaction";
    readonly phase: "started" | "finished";
    readonly strategy: string;
    readonly outcome?:
        | "compacted"
        | "not_needed"
        | "no_boundary"
        | "rejected"
        | "unavailable"
        | "cancelled"
        | "busy";
    readonly reason?: string;
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

export interface ToolFinishedUpdate {
    readonly type: "tool_finished";
    readonly tool: string;
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

export type UiRequestUpdate =
    | ToolApprovalUiRequestUpdate
    | UserQuestionUiRequestUpdate;

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
    readonly seq: number;
}

export interface ModelSettingsRejectedUpdate {
    readonly type: "model_settings_rejected";
    readonly requestId: string;
    readonly reason: "invalid" | "unavailable";
    readonly seq: number;
}

export interface PermissionsUpdate {
    readonly type: "permissions";
    readonly requestId: string;
    readonly mode: ApprovalMode;
    readonly pending: boolean;
    readonly inspection?: PermissionInspection;
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

export type ImageAttachmentReplyUpdate =
    | ImageAttachedUpdate
    | ImageAttachmentRejectedUpdate;

export type AgentUpdate =
    | HistoryUpdate
    | UserPromptUpdate
    | AssistantDeltaUpdate
    | ToolStartedUpdate
    | ToolReviewUpdate
    | ToolFinishedUpdate
    | ToolPresentationUpdate
    | TurnFinishedUpdate
    | AgentFailedUpdate
    | ContextUpdate
    | CompactionUpdate
    | StatusUpdate
    | TaskNotificationUpdate
    | UiRequestUpdate
    | UiRequestClosedUpdate
    | ModelSettingsUpdate
    | ModelSettingsRejectedUpdate
    | PermissionsUpdate
    | PermissionsRejectedUpdate
    | SessionNameReplyUpdate
    | TimelineReplyUpdate
    | ImageAttachmentReplyUpdate;

export interface AgentUpdateSender {
    send(update: AgentUpdate): void;
}

export interface ProtocolEncoder extends EngineEventSubscriber {
    checkpoint(messages: readonly ModelMessage[]): void;
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
    if (command.type === "abort") {
        return { type: "abort" };
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
        command.type === "update_model_settings"
        && isRequestId(command.requestId)
    ) {
        const patch = parseModelSettingsPatch(command.patch);
        if (patch !== undefined) {
            return {
                type: "update_model_settings",
                requestId: command.requestId,
                patch,
            };
        }
    }
    if (
        command.type === "update_pin"
        && isRequestId(command.requestId)
        && (command.action === "add" || command.action === "remove")
        && isNonEmptyString(command.provider)
        && isNonEmptyString(command.model)
    ) {
        return {
            type: "update_pin",
            requestId: command.requestId,
            action: command.action,
            provider: command.provider,
            model: command.model,
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
    if (
        (!hasProvider && !hasModel && !hasReasoningEffort)
        || (hasProvider
            && (typeof source.provider !== "string"
                || source.provider.trim().length === 0))
        || (hasModel
            && (typeof source.model !== "string"
                || source.model.trim().length === 0))
        || (hasReasoningEffort
            && source.reasoningEffort !== null
            && !isModelReasoningEffort(source.reasoningEffort))
    ) {
        return undefined;
    }
    const provider = hasProvider ? source.provider as string : undefined;
    const model = hasModel ? source.model as string : undefined;
    const reasoningEffort = hasReasoningEffort
        ? source.reasoningEffort as ModelReasoningEffort | null
        : undefined;
    return {
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
): ProtocolEncoder {
    let seq = 0;
    let measuredCapacity: number | undefined;
    let measuredModel: string | undefined;

    const encode = (event: Parameters<EngineEventSubscriber>[0]): void => {
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

        if (event.type === "tool_execution_finished") {
            seq += 1;
            sender.send({
                type: "tool_finished",
                tool: event.toolCall.name,
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
            seq += 1;
            sender.send({
                type: "context",
                measurement: event.measurement,
                seq,
            });
        }

        if (event.type === "compaction_started") {
            seq += 1;
            sender.send({
                type: "compaction",
                phase: "started",
                strategy: event.strategy,
                seq,
            });
        }

        if (event.type === "compaction_finished") {
            seq += 1;
            sender.send({
                type: "compaction",
                phase: "finished",
                strategy: event.strategy,
                outcome: event.outcome,
                ...(event.reason === undefined ? {} : { reason: event.reason }),
                ...(event.before === undefined ? {} : { before: event.before }),
                ...(event.after === undefined ? {} : { after: event.after }),
                seq,
            });
        }

        if (event.type === "turn_finished") {
            // The provider counted the request the engine had only estimated,
            // so the turn ends on the authoritative number rather than leaving
            // the estimate standing as the last word. The window is the one
            // that request was measured against; re-deriving it from the
            // catalog would drop a locally discovered model's.
            const reported = reportedMeasurement(
                event.message,
                event.message.source.model === measuredModel
                    ? measuredCapacity
                    : undefined,
            );
            if (reported !== undefined) {
                seq += 1;
                sender.send({ type: "context", measurement: reported, seq });
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
                seq,
            });
        }
    };

    return Object.assign(encode, {
        checkpoint(messages: readonly ModelMessage[]): void {
            const context = latestMeasurement(
                messages,
                measuredModel,
                measuredCapacity,
            );
            sender.send({
                type: "history",
                entries: projectTranscript(messages, attachmentName),
                ...(context === undefined ? {} : { context }),
                seq,
            });
        },
    });
}

/**
 * A reconnecting client needs a number before the next turn produces one, and
 * the last response's usage is the only measurement that survives a restart.
 * A capacity measured this session is preferred over the catalog's, which has
 * no entry for a locally served model.
 */
function latestMeasurement(
    messages: readonly ModelMessage[],
    measuredModel?: string,
    capacity?: number,
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
            message.source.model === measuredModel ? capacity : undefined,
        );
        if (measurement !== undefined) {
            return measurement;
        }
    }
    return undefined;
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

export function projectTranscript(
    messages: readonly ModelMessage[],
    attachmentName?: AttachmentNameLookup,
): readonly TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];

    for (const message of messages) {
        if (message.role === "user") {
            if (message.internal === true) {
                continue;
            }
            entries.push({
                kind: "user",
                text: textContent(message.content),
                ...attachmentRefs(message.content, attachmentName),
            });
            continue;
        }
        if (message.role === "tool_result") {
            if (message.presentation !== undefined) {
                entries.push({
                    kind: "presentation",
                    presentation: structuredClone(message.presentation),
                });
            }
            continue;
        }
        if (isEmptyAssistantMessage(message)) {
            entries.push({ kind: "empty" });
            continue;
        }
        for (const content of message.content) {
            if (content.type === "text" && content.text.length > 0) {
                entries.push({ kind: "assistant", text: content.text });
            }
            if (content.type === "tool_call") {
                entries.push({
                    kind: "tool",
                    tool: content.name,
                    args: structuredClone(content.input),
                });
            }
        }
        if (message.stopReason === "error") {
            const detail = terminalDetail(message);
            entries.push({
                kind: "error",
                ...(detail === undefined ? {} : { detail }),
            });
        }
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
