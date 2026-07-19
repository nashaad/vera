import type {
    AgentUpdate,
    TranscriptEntry,
} from "../engine/protocol.ts";
import { isApprovalMode } from "../engine/permissions.ts";

export function parseAgentUpdate(value: unknown): AgentUpdate | undefined {
    const update = asRecord(value);
    if (update === undefined || !isSequence(update.seq)) {
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
        return value as AgentUpdate;
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
    if (update.type === "checkpoints") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && Array.isArray(update.checkpoints)
                && update.checkpoints.every(isCheckpointEntry)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "checkpoint_restored") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && isCheckpointRestoreResult(update.result)
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "checkpoint_rejected") {
        return typeof update.requestId === "string"
                && update.requestId.length > 0
                && (update.reason === "unavailable"
                    || update.reason === "busy"
                    || update.reason === "not_found"
                    || update.reason === "conflict")
            ? value as AgentUpdate
            : undefined;
    }
    if (update.type === "ui_request") {
        const request = asRecord(update.request);
        const toolCall = asRecord(request?.toolCall);
        return typeof update.requestId === "string"
                && request?.type === "tool_approval"
                && typeof request.reason === "string"
                && typeof request.warning === "string"
                && typeof toolCall?.id === "string"
                && typeof toolCall.name === "string"
                && asRecord(toolCall.input) !== undefined
            ? value as AgentUpdate
            : undefined;
    }
    return undefined;
}

function isCheckpointEntry(value: unknown): boolean {
    const entry = asRecord(value);
    return entry?.type === "checkpoint"
        && typeof entry.timestamp === "string"
        && typeof entry.checkpointId === "string"
        && typeof entry.path === "string"
        && typeof entry.existedBefore === "boolean"
        && (entry.tool === "write" || entry.tool === "edit");
}

function isCheckpointRestoreResult(value: unknown): boolean {
    const result = asRecord(value);
    return result !== undefined
        && typeof result.checkpointId === "string"
        && typeof result.path === "string"
        && (result.action === "restored" || result.action === "removed");
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
    const entry = asRecord(value);
    if (entry?.kind === "user" || entry?.kind === "assistant") {
        return typeof entry.text === "string";
    }
    return entry?.kind === "tool"
        && typeof entry.tool === "string"
        && asRecord(entry.args) !== undefined;
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
