import { readFile } from "node:fs/promises";

import { defaultEventLogPath } from "./engine/events.ts";
import type { PromptContributionMetadata } from "./engine/prompt-contributions.ts";
import type { ModelMessage, ModelTool } from "./model/types.ts";
import { readSessionSnapshot } from "./store/session-store.ts";

export interface InspectedModelRequest {
    readonly format_version: 1;
    readonly session_id: string;
    readonly timestamp: string;
    readonly request: {
        readonly model: string;
        readonly max_tokens: number;
        readonly reasoning_effort?: string;
        readonly system_prompt: string;
        readonly messages: readonly ModelMessage[];
        readonly tools: readonly ModelTool[];
        readonly prompt_contributions?: readonly PromptContributionMetadata[];
    };
}

interface LoggedModelRequest {
    readonly type: "model_request";
    readonly timestamp: string;
    readonly sessionId: string;
    readonly model: string;
    readonly maxTokens: number;
    readonly reasoningEffort?: string;
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
    readonly promptContributions?: readonly PromptContributionMetadata[];
}

export async function inspectLatestModelRequest(
    sessionPath: string,
    eventLogPath?: string,
): Promise<string> {
    const session = await readSessionSnapshot(sessionPath);
    const path = eventLogPath ?? defaultEventLogPath(session.header.id);
    const source = await readFile(path, "utf8");
    const request = latestModelRequest(source, session.header.id, path);
    const inspected: InspectedModelRequest = {
        format_version: 1,
        session_id: session.header.id,
        timestamp: request.timestamp,
        request: {
            model: request.model,
            max_tokens: request.maxTokens,
            ...(request.reasoningEffort === undefined
                ? {}
                : { reasoning_effort: request.reasoningEffort }),
            system_prompt: request.systemPrompt,
            messages: request.messages,
            tools: request.tools,
            ...(request.promptContributions === undefined
                ? {}
                : { prompt_contributions: request.promptContributions }),
        },
    };
    return `${JSON.stringify(inspected, null, 2)}\n`;
}

function latestModelRequest(
    source: string,
    sessionId: string,
    path: string,
): LoggedModelRequest {
    const completeSource = source.endsWith("\n")
        ? source
        : source.slice(0, source.lastIndexOf("\n") + 1);
    const lines = completeSource.trimEnd().split("\n");

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line === undefined || line.length === 0) {
            continue;
        }
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`${path} contains malformed diagnostic JSON`);
        }
        if (isRecord(value) && value.type === "model_request") {
            if (value.sessionId !== sessionId) {
                continue;
            }
            if (!isLoggedModelRequest(value)) {
                throw new Error(`${path} contains an invalid model request`);
            }
            return value;
        }
    }
    throw new Error(`${path} has no model request for session ${sessionId}`);
}

function isLoggedModelRequest(value: unknown): value is LoggedModelRequest {
    if (!isRecord(value)) {
        return false;
    }
    return value.type === "model_request"
        && typeof value.timestamp === "string"
        && typeof value.sessionId === "string"
        && typeof value.model === "string"
        && value.model.length > 0
        && typeof value.maxTokens === "number"
        && Number.isInteger(value.maxTokens)
        && value.maxTokens > 0
        && (value.reasoningEffort === undefined
            || isReasoningEffort(value.reasoningEffort))
        && typeof value.systemPrompt === "string"
        && Array.isArray(value.messages)
        && value.messages.every(isModelMessage)
        && Array.isArray(value.tools)
        && value.tools.every(isModelTool)
        && (value.promptContributions === undefined
            || (
                Array.isArray(value.promptContributions)
                && value.promptContributions.every((entry, order) =>
                    isPromptContributionMetadata(entry)
                    && entry.order === order
                )
            ));
}

function isPromptContributionMetadata(
    value: unknown,
): value is PromptContributionMetadata {
    return isRecord(value)
        && typeof value.id === "string"
        && value.id.length > 0
        && value.owner === "core"
        && (value.target === "stable" || value.target === "contextual")
        && typeof value.order === "number"
        && Number.isSafeInteger(value.order)
        && value.order >= 0
        && typeof value.bytes === "number"
        && Number.isSafeInteger(value.bytes)
        && value.bytes >= 0
        && typeof value.sha256 === "string"
        && /^[a-f0-9]{64}$/.test(value.sha256);
}

function isModelMessage(value: unknown): value is ModelMessage {
    if (!isRecord(value) || !Array.isArray(value.content)) {
        return false;
    }
    if (value.role === "user") {
        return (value.internal === undefined || typeof value.internal === "boolean")
            && value.content.every((block) =>
                isTextContent(block) || isImageAttachmentContent(block)
            );
    }
    if (value.role === "tool_result") {
        return typeof value.toolCallId === "string"
            && typeof value.toolName === "string"
            && typeof value.isError === "boolean"
            && value.content.every(isTextContent);
    }
    if (value.role !== "assistant") {
        return false;
    }
    return isModelSource(value.source)
        && isModelUsage(value.usage)
        && isStopReason(value.stopReason)
        && (value.errorMessage === undefined
            || typeof value.errorMessage === "string")
        && value.content.every(isAssistantContent);
}

function isTextContent(value: unknown): boolean {
    return isRecord(value)
        && value.type === "text"
        && typeof value.text === "string";
}

function isImageAttachmentContent(value: unknown): boolean {
    return isRecord(value)
        && value.type === "image_attachment"
        && typeof value.attachmentId === "string"
        && value.attachmentId.length > 0;
}

function isAssistantContent(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (value.type === "text") {
        return typeof value.text === "string";
    }
    if (value.type === "thinking") {
        return typeof value.text === "string"
            && (value.signature === undefined
                || typeof value.signature === "string");
    }
    return value.type === "tool_call"
        && typeof value.id === "string"
        && typeof value.name === "string"
        && isRecord(value.input)
        && (value.signature === undefined || typeof value.signature === "string");
}

function isModelSource(value: unknown): boolean {
    return isRecord(value)
        && typeof value.provider === "string"
        && typeof value.api === "string"
        && typeof value.model === "string"
        && (value.responseModel === undefined
            || typeof value.responseModel === "string");
}

function isModelUsage(value: unknown): boolean {
    return isRecord(value)
        && typeof value.inputTokens === "number"
        && typeof value.outputTokens === "number"
        && typeof value.cachedInputTokens === "number"
        && typeof value.reasoningTokens === "number"
        && typeof value.totalTokens === "number"
        && (value.cost === undefined || typeof value.cost === "number");
}

function isStopReason(value: unknown): boolean {
    return value === "stop"
        || value === "length"
        || value === "tool_use"
        || value === "content_filter"
        || value === "aborted"
        || value === "error";
}

function isModelTool(value: unknown): value is ModelTool {
    return isRecord(value)
        && typeof value.name === "string"
        && typeof value.description === "string"
        && isRecord(value.inputSchema);
}

function isReasoningEffort(value: unknown): boolean {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
