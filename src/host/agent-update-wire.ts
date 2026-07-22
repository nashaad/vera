import type {
    AgentUpdate,
    TranscriptEntry,
} from "../engine/protocol.ts";
import {
    isApprovalMode,
    isCommandPrefix,
} from "../engine/permissions.ts";

export function parseAgentUpdate(value: unknown): AgentUpdate | undefined {
    const update = asRecord(value);
    if (update === undefined) {
        return undefined;
    }
    if (isTimelineReplyType(update.type)) {
        return update.seq === undefined ? parseTimelineReply(value, update) : undefined;
    }
    if (!isSequence(update.seq)) {
        return undefined;
    }
    if (update.type === "history") {
        return Array.isArray(update.entries)
            && update.entries.every(isTranscriptEntry)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "user_prompt") {
        return typeof update.content === "string" ? value as AgentUpdate : undefined;
    }
    if (update.type === "assistant_delta") {
        return typeof update.text === "string" ? value as AgentUpdate : undefined;
    }
    if (update.type === "tool_started") {
        return typeof update.tool === "string" && asRecord(update.args) !== undefined
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "tool_finished") {
        return typeof update.tool === "string" ? value as AgentUpdate : undefined;
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
                && (settings.reasoningEffort === undefined
                    || isModelReasoningEffort(settings.reasoningEffort))
                && (settings.availableReasoningEfforts === undefined
                    || (Array.isArray(settings.availableReasoningEfforts)
                        && settings.availableReasoningEfforts.every(
                            isModelReasoningEffort,
                        )))
                && (settings.availableModels === undefined
                    || (Array.isArray(settings.availableModels)
                        && settings.availableModels.every(isSuggestedModel)))
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
            ? value as AgentUpdate
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
                && (
                    request.commandPrefix === undefined
                    || isCommandPrefix(request.commandPrefix)
                )
                && typeof toolCall?.id === "string"
                && typeof toolCall.name === "string"
                && asRecord(toolCall.input) !== undefined
            ? value as AgentUpdate
            : undefined;
    }
    return undefined;
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

function isTimelineBoundary(value: unknown): boolean {
    const boundary = asRecord(value);
    return typeof boundary?.userMessageId === "string"
        && boundary.userMessageId.length > 0
        && typeof boundary.timestamp === "string"
        && typeof boundary.prompt === "string"
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
    if (entry?.kind === "user" || entry?.kind === "assistant") {
        return typeof entry.text === "string";
    }
    if (entry?.kind === "error") {
        return entry.detail === undefined
            || (typeof entry.detail === "string"
                && entry.detail.trim().length > 0);
    }
    return entry?.kind === "tool"
        && typeof entry.tool === "string"
        && asRecord(entry.args) !== undefined;
}

function isSuggestedModel(value: unknown): boolean {
    const model = asRecord(value);
    return typeof model?.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.description === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isSequence(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isModelReasoningEffort(value: unknown): boolean {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}
