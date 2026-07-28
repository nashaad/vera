import type {
    AgentUpdate,
    TranscriptEntry,
} from "../engine/protocol.ts";
import type { PermissionInspection } from "../engine/permissions.ts";
import {
    isApprovalMode,
    isPermissionInspection,
    isPermissionGrantProposal,
} from "../engine/permissions.ts";
import { isPermissionPredicate } from "../engine/permission-grants.ts";
import { isContextMeasurement } from "../engine/context-measurement.ts";

export function parseAgentUpdate(value: unknown): AgentUpdate | undefined {
    const update = asRecord(value);
    if (update === undefined) {
        return undefined;
    }
    if (isTimelineReplyType(update.type)) {
        return update.seq === undefined ? parseTimelineReply(value, update) : undefined;
    }
    if (isSessionNameReplyType(update.type)) {
        return update.seq === undefined
            ? parseSessionNameReply(value, update)
            : undefined;
    }
    if (isImageAttachmentReplyType(update.type)) {
        return update.seq === undefined
            ? parseImageAttachmentReply(value, update)
            : undefined;
    }
    if (!isSequence(update.seq)) {
        return undefined;
    }
    if (update.type === "history") {
        return Array.isArray(update.entries)
            && update.entries.every(isTranscriptEntry)
            && (update.context === undefined
                || isContextMeasurement(update.context))
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "context") {
        return isContextMeasurement(update.measurement)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "compaction") {
        return (update.phase === "started" || update.phase === "finished")
                && typeof update.strategy === "string"
                && (update.outcome === undefined
                    || isCompactionOutcome(update.outcome))
                && (update.reason === undefined
                    || typeof update.reason === "string")
                && isOptionalCount(update.before)
                && isOptionalCount(update.after)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "user_prompt") {
        return typeof update.content === "string"
                && isOptionalAttachments(update.attachments)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "assistant_delta") {
        return typeof update.text === "string" ? value as AgentUpdate : undefined;
    }
    if (update.type === "tool_started") {
        return typeof update.tool === "string" && asRecord(update.args) !== undefined
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "tool_review") {
        return typeof update.tool === "string"
                && (update.decision === "allow"
                    || update.decision === "deny"
                    || update.decision === "unavailable")
                && typeof update.reason === "string"
                && isRiskLevel(update.riskLevel)
                && isUserAuthorization(update.userAuthorization)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "tool_finished") {
        return typeof update.tool === "string" ? value as AgentUpdate : undefined;
    }
    if (update.type === "tool_presentation") {
        return typeof update.tool === "string"
                && isToolPresentation(update.presentation)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "turn_finished") {
        return (update.outcome === undefined
                || update.outcome === "error"
                || update.outcome === "aborted")
            && (update.error === undefined
                || (typeof update.error === "string"
                    && update.error.trim().length > 0))
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "agent_failed") {
        return typeof update.failureId === "string"
                && update.failureId.length > 0
                && typeof update.detail === "string"
                && update.detail.trim().length > 0
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "status") {
        return update.state === "idle"
                || update.state === "working"
                || update.state === "waiting"
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "task_notification") {
        return typeof update.deliveryId === "string"
                && update.deliveryId.length > 0
                && typeof update.sourceAgentId === "string"
                && update.sourceAgentId.length > 0
                && typeof update.content === "string"
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "ui_request_closed") {
        return typeof update.requestId === "string" ? value as AgentUpdate : undefined;
    }
    if (update.type === "model_settings") {
        const settings = asRecord(update.settings);
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && typeof update.pending === "boolean"
                && typeof settings?.model === "string"
                && settings.model.length > 0
                && (settings.provider === undefined
                    || (typeof settings.provider === "string"
                        && settings.provider.length > 0))
                && (settings.reasoningEffort === undefined
                    || isModelReasoningEffort(settings.reasoningEffort))
                && (settings.availableReasoningEfforts === undefined
                    || (Array.isArray(settings.availableReasoningEfforts)
                        && settings.availableReasoningEfforts.every(
                            isModelReasoningEffort,
                        )))
                && (settings.availableModels === undefined
                    || (Array.isArray(settings.availableModels)
                        && settings.availableModels.every(isAvailableModel)))
                && (settings.pinned === undefined
                    || (Array.isArray(settings.pinned)
                        && settings.pinned.every(isPinnedModel)))
                && (settings.contextWindow === undefined
                    || (Number.isSafeInteger(settings.contextWindow)
                        && (settings.contextWindow as number) > 0))
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "model_settings_rejected") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && (update.reason === "invalid" || update.reason === "unavailable")
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "permissions") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && isApprovalMode(update.mode)
                && typeof update.pending === "boolean"
                ? withPermissionInspection(value, update)
                : undefined;
    }
    if (update.type === "permissions_rejected") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && (update.reason === "invalid" || update.reason === "unavailable")
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "ui_request") {
        const request = asRecord(update.request);
        if (
            typeof update.requestId !== "string"
            || update.requestId.length === 0
        ) {
            return undefined;
        }
        if (request?.type === "user_question") {
            return hasExactKeys(update, ["type", "requestId", "request", "seq"])
                    && isUserQuestionRequest(request)
                ? value as AgentUpdate
                : undefined;
        }
        const toolCall = asRecord(request?.toolCall);
        return request?.type === "tool_approval"
                && typeof request.reason === "string"
                && typeof request.warning === "string"
                && (request.sourceAgentId === undefined
                    || (typeof request.sourceAgentId === "string"
                        && request.sourceAgentId.length > 0))
                && (request.sourceTask === undefined
                    || (typeof request.sourceTask === "string"
                        && request.sourceTask.length > 0))
                && (
                    request.permissionGrants === undefined
                    || (
                        Array.isArray(request.permissionGrants)
                        && request.permissionGrants.length > 0
                        && request.permissionGrants.every(
                            isPermissionGrantProposal,
                        )
                    )
                )
                && typeof toolCall?.id === "string"
                && typeof toolCall.name === "string"
                && asRecord(toolCall.input) !== undefined
            ? value as AgentUpdate
            : undefined;
    }
    return undefined;
}

function isToolPresentation(value: unknown): boolean {
    const presentation = asRecord(value);
    if (presentation?.kind === "unified_diff") {
        return typeof presentation.path === "string"
            && presentation.path.length > 0
            && typeof presentation.patch === "string"
            && presentation.patch.length > 0;
    }
    return presentation?.kind === "tool_notice"
        && typeof presentation.text === "string"
        && presentation.text.trim().length > 0;
}

function withPermissionInspection(
    value: unknown,
    update: Record<string, unknown>,
): AgentUpdate | undefined {
    if (update.inspection === undefined) {
        return value as AgentUpdate;
    }
    if (isPermissionInspection(update.inspection)) {
        return value as AgentUpdate;
    }
    const inspection = migrateLegacyInspection(update.inspection);
    const message = asRecord(value);
    if (inspection === undefined || message === undefined) {
        return undefined;
    }
    return { ...message, inspection } as AgentUpdate;
}

function migrateLegacyInspection(value: unknown): PermissionInspection | undefined {
    const source = asRecord(value);
    const selected = asRecord(source?.selected);
    if (
        selected === undefined
        || typeof selected.name !== "string"
        || !Array.isArray(selected.rules)
        || !Array.isArray(source?.availableProfiles)
        || !Array.isArray(source?.activeGrants)
    ) {
        return undefined;
    }
    const rules = selected.rules.map((rule) => {
        const entry = asRecord(rule);
        const when = legacyPredicate(entry?.when);
        return entry === undefined || typeof entry.name !== "string"
                || when === undefined
                || !isPermissionOutcome(entry.then)
                ? undefined
                : { name: entry.name, when, then: entry.then };
    });
    if (rules.some((rule) => rule === undefined)) {
        return undefined;
    }
    const activeGrants = source.activeGrants.map((grant) => {
        const entry = asRecord(grant);
        const when = legacyPredicate(entry?.when);
        return typeof entry?.id === "string"
                && entry.id.length > 0
                && (entry.kind === "action"
                    || entry.kind === "capability"
                    || entry.kind === "command")
                && entry.scope === "session"
                && entry.lifetime === "session"
                && when !== undefined
            ? {
                id: entry.id,
                kind: entry.kind === "capability" ? "action" : entry.kind,
                when,
                scope: "session" as const,
                lifetime: "session" as const,
            }
            : undefined;
    });
    if (
        activeGrants.some((grant) => grant === undefined)
        || !source.availableProfiles.every(
            (name) => typeof name === "string" && name.length > 0,
        )
        || !isPermissionOutcome(selected.defaultOutcome)
    ) {
        return undefined;
    }
    return {
        selected: {
            name: selected.name,
            rules: rules as PermissionInspection["selected"]["rules"],
            defaultOutcome: selected.defaultOutcome,
            ...(typeof selected.reviewerProfile === "string"
                ? { reviewerProfile: selected.reviewerProfile }
                : {}),
        },
        // Read under the legacy name, emitted under the current one: this
        // function exists precisely to decode inspections sent before the
        // profile-to-mode rename.
        availableModes: source.availableProfiles as string[],
        activeGrants: activeGrants as PermissionInspection["activeGrants"],
    };
}

function legacyPredicate(value: unknown) {
    const source = asRecord(value);
    if (source === undefined) {
        return undefined;
    }
    const predicate: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(source)) {
        if (key === "capability") {
            predicate.verb = raw === "execute" || raw === "network"
                ? "unknown"
                : raw;
        } else if (key === "pathScope" || key === "path_scope") {
            predicate.scope = raw;
        } else if (
            key === "tool"
            || key === "verb"
            || key === "path"
            || key === "scope"
            || key === "operation"
            || key === "executable"
        ) {
            predicate[key] = raw;
        }
    }
    return isPermissionPredicate(predicate) ? predicate : undefined;
}

function isPermissionOutcome(value: unknown): value is "allow" | "review" | "ask" | "deny" {
    return value === "allow"
        || value === "review"
        || value === "ask"
        || value === "deny";
}

function isUserQuestionRequest(request: Record<string, unknown>): boolean {
    if (
        !hasExactKeys(request, ["type", "question", "choices"])
        || typeof request.question !== "string"
        || request.question.trim().length === 0
        || !Array.isArray(request.choices)
        || request.choices.length < 2
        || request.choices.length > 9
    ) {
        return false;
    }
    const ids = new Set<string>();
    for (const value of request.choices) {
        const choice = asRecord(value);
        if (
            choice === undefined
            || !hasExactKeys(choice, ["id", "label"])
            || typeof choice.id !== "string"
            || choice.id.trim().length === 0
            || typeof choice.label !== "string"
            || choice.label.trim().length === 0
            || ids.has(choice.id)
        ) {
            return false;
        }
        ids.add(choice.id);
    }
    return true;
}

function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length
        && expected.every((key) => Object.hasOwn(value, key));
}

function parseTimelineReply(
    value: unknown,
    update: Record<string, unknown>,
): AgentUpdate | undefined {
    if (update.type === "timeline") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && Array.isArray(update.boundaries)
                && update.boundaries.every(isTimelineBoundary)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "timeline_action_preview") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && isTimelinePlan(update.plan)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "timeline_action_applied") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && typeof update.planId === "string"
                && update.planId.length > 0
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "timeline_action_rejected") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && (update.operation === "preview" || update.operation === "apply")
                && (
                    update.reason === "busy"
                    || update.reason === "plan_expired"
                    || update.reason === "not_plan_owner"
                    || update.reason === "boundary_missing"
                    || update.reason === "session_changed"
                    || update.reason === "unavailable"
                )
            ? value as AgentUpdate
            : undefined;
    }
    return undefined;
}

function isTimelineReplyType(value: unknown): boolean {
    return value === "timeline"
        || value === "timeline_action_preview"
        || value === "timeline_action_applied"
        || value === "timeline_action_rejected";
}

function isSessionNameReplyType(value: unknown): boolean {
    return value === "session_name" || value === "session_name_rejected";
}

function parseSessionNameReply(
    value: unknown,
    update: Record<string, unknown>,
): AgentUpdate | undefined {
    if (
        typeof update.requestId !== "string"
        || update.requestId.length === 0
    ) {
        return undefined;
    }
    if (update.type === "session_name") {
        return typeof update.name === "string" || update.name === null
            ? value as AgentUpdate
            : undefined;
    }
    return update.reason === "invalid" || update.reason === "unavailable"
        ? value as AgentUpdate
        : undefined;
}

function isImageAttachmentReplyType(value: unknown): boolean {
    return value === "image_attached" || value === "image_attachment_rejected";
}

function parseImageAttachmentReply(
    value: unknown,
    update: Record<string, unknown>,
): AgentUpdate | undefined {
    if (typeof update.requestId !== "string" || update.requestId.length === 0) {
        return undefined;
    }
    if (update.type === "image_attachment_rejected") {
        return typeof update.error === "string" && update.error.trim().length > 0
            ? value as AgentUpdate
            : undefined;
    }
    const attachment = asRecord(update.attachment);
    return typeof attachment?.id === "string"
            && attachment.id.length > 0
            && typeof attachment.name === "string"
            && attachment.name.length > 0
            && typeof attachment.mediaType === "string"
            && Number.isSafeInteger(attachment.bytes)
            && (attachment.bytes as number) > 0
            && Number.isSafeInteger(attachment.width)
            && (attachment.width as number) > 0
            && Number.isSafeInteger(attachment.height)
            && (attachment.height as number) > 0
        ? value as AgentUpdate
        : undefined;
}

function isTimelineBoundary(value: unknown): boolean {
    const boundary = asRecord(value);
    return typeof boundary?.userMessageId === "string"
        && boundary.userMessageId.length > 0
        && typeof boundary.timestamp === "string"
        && typeof boundary.prompt === "string"
        && isOptionalAttachments(boundary.attachments)
        && isSequence(boundary.position);
}

function isTimelinePlan(value: unknown): boolean {
    const plan = asRecord(value);
    return typeof plan?.planId === "string"
        && plan.planId.length > 0
        && typeof plan.expectedHeadId === "string"
        && plan.expectedHeadId.length > 0
        && isTimelineBoundary(plan.boundary)
        && isSequence(plan.keptMessageCount)
        && isSequence(plan.setAsideMessageCount);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
    const entry = asRecord(value);
    if (entry?.kind === "user") {
        return typeof entry.text === "string"
            && isOptionalAttachments(entry.attachments);
    }
    if (entry?.kind === "assistant") {
        return typeof entry.text === "string";
    }
    if (entry?.kind === "error") {
        return entry.detail === undefined
            || (typeof entry.detail === "string"
                && entry.detail.trim().length > 0);
    }
    if (entry?.kind === "presentation") {
        return isToolPresentation(entry.presentation);
    }
    return entry?.kind === "tool"
        && typeof entry.tool === "string"
        && asRecord(entry.args) !== undefined;
}

function isOptionalAttachments(value: unknown): boolean {
    return value === undefined || (
        Array.isArray(value)
        && value.every((entry) => {
            const attachment = asRecord(entry);
            return typeof attachment?.id === "string"
                && attachment.id.length > 0
                && (attachment.name === undefined
                    || typeof attachment.name === "string");
        })
    );
}

/**
 * `levels` is required, and an entry without it is rejected rather than read
 * as empty: empty already means "no reasoning control at all", so normalising
 * absent to empty would hide a producer that forgot the field. See the same
 * note in `src/engine/model-settings.ts`.
 */
function isAvailableModel(value: unknown): boolean {
    const model = asRecord(value);
    return typeof model?.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.description === "string"
        && (model.contextWindow === undefined
            || (Number.isSafeInteger(model.contextWindow)
                && (model.contextWindow as number) > 0))
        && isLevelList(model.levels)
        && (model.defaultLevel === undefined
            || typeof model.defaultLevel === "string");
}

function isPinnedModel(value: unknown): boolean {
    const model = asRecord(value);
    return typeof model?.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.available === "boolean"
        && (model.description === undefined
            || typeof model.description === "string")
        && (model.contextWindow === undefined
            || (Number.isSafeInteger(model.contextWindow)
                && (model.contextWindow as number) > 0))
        && isLevelList(model.levels)
        && (model.defaultLevel === undefined
            || typeof model.defaultLevel === "string");
}

function isLevelList(value: unknown): boolean {
    return Array.isArray(value) && value.every(isReasoningLevel);
}

function isReasoningLevel(value: unknown): boolean {
    const level = asRecord(value);
    return typeof level?.id === "string"
        && typeof level.label === "string"
        && (level.description === undefined
            || typeof level.description === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isSequence(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalCount(value: unknown): boolean {
    return value === undefined
        || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isCompactionOutcome(value: unknown): boolean {
    return value === "compacted"
        || value === "not_needed"
        || value === "no_boundary"
        || value === "rejected"
        || value === "unavailable"
        || value === "cancelled"
        || value === "busy";
}

function isRiskLevel(value: unknown): boolean {
    return value === "low"
        || value === "medium"
        || value === "high"
        || value === "critical";
}

function isUserAuthorization(value: unknown): boolean {
    return value === "unknown"
        || value === "low"
        || value === "medium"
        || value === "high";
}

function isModelReasoningEffort(value: unknown): boolean {
    return typeof value === "string" && value.length > 0;
}
