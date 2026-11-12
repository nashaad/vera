import type {
    AgentRunStatus,
    BackgroundAgents,
    CompactionState,
    ContextState,
    ImageReply,
    Presentation,
    QueuedPrompt,
    RetryState,
    TimelineReply,
    UsageRow,
} from "./model.ts";
import { parseModelRefusal, parseModelSettingsReply, type ModelRefusal, type ModelSettingsReply } from "../models/settings.ts";
import { parsePermissions, type ApprovalState } from "./permissions.ts";
import { parseUiRequest, type OpenRequest } from "./requests.ts";
import {
    parseBackground,
    parseCompaction,
    parseContext,
    parseDelivery,
    parseModelFailure,
    parsePresentation,
    parseRetry,
    parseSubstitution,
    parseTimelineReply,
    parseUsage,
    type Delivery,
    type ModelFailure,
    type Substitution,
} from "./wireTools.ts";

// Wire shapes the session view reads. Fields the view never uses are left out.
// An entry the view does not show parses as "other", so entry indexes stay put.

export interface PageInfo {
    readonly hasMore: boolean;
    readonly olderBefore?: string;
}

interface EntryBase {
    readonly id?: string;
    readonly recordedAt?: number;
}

export interface UserEntry extends EntryBase {
    readonly kind: "user";
    readonly text: string;
}

export interface AssistantEntry extends EntryBase {
    readonly kind: "assistant";
    readonly text: string;
}

export interface ReasoningEntry extends EntryBase {
    readonly kind: "reasoning";
    readonly text: string;
}

export interface ToolEntry extends EntryBase {
    readonly kind: "tool";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResultEntry extends EntryBase {
    readonly kind: "tool_result";
    readonly tool: string;
    readonly output: string;
    readonly isError: boolean;
}

export interface ErrorEntry extends EntryBase {
    readonly kind: "error";
    readonly outcome?: "error" | "aborted";
    readonly detail?: string;
    readonly modelFailure?: ModelFailure;
}

// A turn that ended with no text, no tool call and no reasoning.
export interface EmptyEntry extends EntryBase {
    readonly kind: "empty";
}

export interface PresentationEntry extends EntryBase {
    readonly kind: "presentation";
    readonly presentation: Presentation;
}

export interface SubstitutionEntry extends EntryBase {
    readonly kind: "model_substitution";
    readonly substitution: Substitution;
}

export interface DeliveryEntry extends EntryBase {
    readonly kind: "delivery";
    readonly delivery: Delivery;
}

export interface HarnessEntry extends EntryBase {
    readonly kind: "harness";
    readonly text: string;
    readonly tone: string;
}

export interface OtherEntry {
    readonly kind: "other";
}

export type WireEntry =
    | UserEntry
    | AssistantEntry
    | ReasoningEntry
    | ToolEntry
    | ToolResultEntry
    | ErrorEntry
    | EmptyEntry
    | PresentationEntry
    | SubstitutionEntry
    | DeliveryEntry
    | HarnessEntry
    | OtherEntry;

export interface AttachedMessage {
    readonly type: "attached";
    readonly background?: BackgroundAgents;
}

export interface AttachFailedMessage {
    readonly type: "attach_failed";
    readonly reason: string;
}

export interface HistoryMessage {
    readonly type: "history";
    readonly entries: readonly WireEntry[];
    readonly status?: AgentRunStatus;
    readonly page?: PageInfo;
    readonly queue?: readonly QueuedPrompt[];
    readonly context?: ContextState;
    readonly usage?: readonly UsageRow[];
}

export interface HistoryPageMessage {
    readonly type: "history_page";
    readonly requestId: string;
    readonly entries: readonly WireEntry[];
    readonly page: PageInfo;
}

export interface HistoryPageFailedMessage {
    readonly type: "history_page_failed";
    readonly requestId: string;
    readonly reason: string;
}

export interface SessionTitleMessage {
    readonly type: "session_title";
    readonly title?: string;
}

export interface UserPromptMessage {
    readonly type: "user_prompt";
    readonly content: string;
}

export interface AssistantDeltaMessage {
    readonly type: "assistant_delta";
    readonly text: string;
}

export interface AssistantThinkingMessage {
    readonly type: "assistant_thinking";
    readonly text: string;
}

export interface ToolStartedMessage {
    readonly type: "tool_started";
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolFinishedMessage {
    readonly type: "tool_finished";
    readonly tool: string;
    readonly output?: string;
    readonly isError: boolean;
}

export interface TurnFinishedMessage {
    readonly type: "turn_finished";
    readonly outcome?: "error" | "aborted";
    readonly error?: string;
    readonly modelFailure?: ModelFailure;
    readonly empty: boolean;
    readonly usage?: readonly UsageRow[];
}

export interface StatusMessage {
    readonly type: "status";
    readonly state: AgentRunStatus;
}

export interface AgentFailedMessage {
    readonly type: "agent_failed";
    readonly detail: string;
}

// Sent after `tool_finished`; it names the tool but not the call.
export interface ToolPresentationMessage {
    readonly type: "tool_presentation";
    readonly tool: string;
    readonly presentation: Presentation;
}

export interface SubstitutionMessage {
    readonly type: "model_substitution";
    readonly substitution: Substitution;
    readonly source: "turn" | "subagent";
}

export interface DeliveryMessage {
    readonly type: "task_notification";
    readonly delivery: Delivery;
}

// From `model_activity` with phase retrying.
export interface ModelRetryMessage {
    readonly type: "model_retry";
    readonly retry: RetryState;
    // The streamed text so far will be sent again from the start.
    readonly replacesPartial: boolean;
}

export type LiveMessage =
    | UserPromptMessage
    | AssistantDeltaMessage
    | AssistantThinkingMessage
    | ToolStartedMessage
    | ToolFinishedMessage
    | ToolPresentationMessage
    | SubstitutionMessage
    | DeliveryMessage
    | ModelRetryMessage
    | TurnFinishedMessage
    | StatusMessage
    | AgentFailedMessage;

export interface ContextMessage {
    readonly type: "context";
    readonly context: ContextState;
}

export interface CompactionMessage {
    readonly type: "compaction";
    readonly compaction: CompactionState;
}

// One of the replies to this window's `list_timeline` and timeline action commands.
export interface TimelineMessage {
    readonly type: "timeline_reply";
    readonly reply: TimelineReply;
}

export interface BackgroundAgentsMessage {
    readonly type: "background_agents";
    readonly background: BackgroundAgents;
}

export interface PromptQueueMessage {
    readonly type: "prompt_queue";
    readonly queue: readonly QueuedPrompt[];
}

export interface PromptWithdrawnMessage {
    readonly type: "prompt_withdrawn";
    readonly requestId: string;
    readonly content: string;
}

// From `prompt_admission` with status rejected, or from `prompt_rejected`.
export interface PromptRefusedMessage {
    readonly type: "prompt_refused";
    readonly requestId?: string;
    readonly content?: string;
    readonly reason: string;
}

// An `image_attached` or `image_attachment_rejected` reply to this client's `attach_image`.
export interface ImageReplyMessage {
    readonly type: "image_reply";
    readonly reply: ImageReply;
}

export interface UiRequestMessage {
    readonly type: "ui_request";
    readonly request: OpenRequest;
}

export interface UiRequestClosedMessage {
    readonly type: "ui_request_closed";
    readonly requestId: string;
}

export interface PermissionsMessage {
    readonly type: "permissions";
    readonly approval: ApprovalState;
}

export interface PermissionsRejectedMessage {
    readonly type: "permissions_rejected";
    readonly requestId: string;
}

export interface ModelSettingsMessage {
    readonly type: "model_settings";
    readonly reply: ModelSettingsReply;
}

export interface ModelRefusedMessage {
    readonly type: "model_settings_rejected";
    readonly refusal: ModelRefusal;
}

export type SessionMessage =
    | AttachedMessage
    | AttachFailedMessage
    | HistoryMessage
    | HistoryPageMessage
    | HistoryPageFailedMessage
    | SessionTitleMessage
    | PromptQueueMessage
    | PromptWithdrawnMessage
    | PromptRefusedMessage
    | ImageReplyMessage
    | UiRequestMessage
    | UiRequestClosedMessage
    | PermissionsMessage
    | PermissionsRejectedMessage
    | ModelSettingsMessage
    | ModelRefusedMessage
    | ContextMessage
    | CompactionMessage
    | TimelineMessage
    | BackgroundAgentsMessage
    | LiveMessage;

type Fields = Record<string, unknown>;

const OTHER: OtherEntry = { kind: "other" };

// Lines that are not JSON objects, or whose fields this view cannot read, yield undefined.
export function parseSessionLine(text: string): SessionMessage | undefined {
    const value = parseJson(text);
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    return parseMessage(value.type, value);
}

export function historyPageRequest(requestId: string, before: string): string {
    return `${JSON.stringify({ type: "history_page", request_id: requestId, before })}\n`;
}

export function promptCommand(content: string, requestId: string, attachmentIds: readonly string[] = []): string {
    const images = attachmentIds.length === 0 ? {} : { attachmentIds };
    return `${JSON.stringify({ type: "prompt", content, requestId, ...images })}\n`;
}

export function attachImageCommand(requestId: string, path: string): string {
    return `${JSON.stringify({ type: "attach_image", requestId, path })}\n`;
}

export function abortCommand(): string {
    return `${JSON.stringify({ type: "abort" })}\n`;
}

export function releaseQueuedCommand(mode: "one" | "all"): string {
    return `${JSON.stringify({ type: "release_queued_prompts", mode })}\n`;
}

export function withdrawQueuedCommand(requestId: string): string {
    return `${JSON.stringify({ type: "withdraw_queued_prompt", requestId })}\n`;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function parseMessage(type: string, value: Fields): SessionMessage | undefined {
    switch (type) {
        case "attached": {
            const background = parseBackground(value.background_agents);
            return background === undefined ? { type: "attached" } : { type: "attached", background };
        }
        case "attach_failed":
            return parseAttachFailed(value);
        case "history":
            return parseHistory(value);
        case "history_page":
            return parseHistoryPage(value);
        case "history_page_failed":
            return parseHistoryPageFailed(value);
        case "session_title":
            return { type: "session_title", title: str(value.title) };
        case "prompt_queue": {
            const queue = isRecord(value.queue) ? queueOf(value.queue.prompts) : undefined;
            return queue === undefined ? undefined : { type: "prompt_queue", queue };
        }
        case "prompt_withdrawn": {
            const requestId = str(value.requestId);
            const content = str(value.content);
            if (requestId === undefined || content === undefined) return undefined;
            return { type: "prompt_withdrawn", requestId, content };
        }
        case "prompt_admission":
            return value.status === "rejected"
                ? refused(str(value.requestId), str(value.content), str(value.reason))
                : undefined;
        case "prompt_rejected":
            return refused(str(value.requestId), undefined, str(value.reason));
        case "image_attached": {
            const requestId = str(value.requestId);
            const attachmentId = isRecord(value.attachment) ? str(value.attachment.id) : undefined;
            if (requestId === undefined || attachmentId === undefined) return undefined;
            return { type: "image_reply", reply: { requestId, outcome: "attached", attachmentId } };
        }
        case "image_attachment_rejected": {
            const requestId = str(value.requestId);
            if (requestId === undefined) return undefined;
            const error = str(value.error) ?? "The image could not be attached.";
            return { type: "image_reply", reply: { requestId, outcome: "rejected", error } };
        }
        case "ui_request": {
            const request = parseUiRequest(value);
            return request === undefined ? undefined : { type: "ui_request", request };
        }
        case "ui_request_closed": {
            const requestId = str(value.requestId);
            return requestId === undefined ? undefined : { type: "ui_request_closed", requestId };
        }
        case "permissions": {
            const approval = parsePermissions(value);
            return approval === undefined ? undefined : { type: "permissions", approval };
        }
        case "permissions_rejected": {
            const requestId = str(value.requestId);
            return requestId === undefined ? undefined : { type: "permissions_rejected", requestId };
        }
        case "model_settings": {
            const reply = parseModelSettingsReply(value);
            return reply === undefined ? undefined : { type: "model_settings", reply };
        }
        case "model_settings_rejected": {
            const refusal = parseModelRefusal(value);
            return refusal === undefined ? undefined : { type: "model_settings_rejected", refusal };
        }
        case "context": {
            const context = parseContext(value.measurement);
            return context === undefined ? undefined : { type: "context", context };
        }
        case "compaction": {
            const compaction = parseCompaction(value);
            return compaction === undefined ? undefined : { type: "compaction", compaction };
        }
        case "timeline":
        case "timeline_action_preview":
        case "timeline_action_applied":
        case "timeline_action_rejected": {
            const reply = parseTimelineReply(type, value);
            return reply === undefined ? undefined : { type: "timeline_reply", reply };
        }
        case "background_agents": {
            const background = parseBackground(value);
            return background === undefined ? undefined : { type: "background_agents", background };
        }
        default:
            return parseLive(type, value);
    }
}

function parseAttachFailed(value: Fields): AttachFailedMessage | undefined {
    const reason = str(value.reason);
    return reason === undefined ? undefined : { type: "attach_failed", reason };
}

function parseHistory(value: Fields): HistoryMessage | undefined {
    const entries = entriesOf(value.entries);
    if (entries === undefined) return undefined;
    const queue = isRecord(value.promptQueue) ? queueOf(value.promptQueue.prompts) : undefined;
    const context = parseContext(value.context);
    const usage = parseUsage(value.usage);
    return {
        type: "history",
        entries,
        status: statusOf(value.status),
        page: pageOf(value.page),
        ...(queue === undefined ? {} : { queue }),
        ...(context === undefined ? {} : { context }),
        ...(usage === undefined ? {} : { usage }),
    };
}

function parseHistoryPage(value: Fields): HistoryPageMessage | undefined {
    const requestId = str(value.request_id);
    const entries = entriesOf(value.entries);
    const page = pageOf(value.page);
    if (requestId === undefined || entries === undefined || page === undefined) return undefined;
    return { type: "history_page", requestId, entries, page };
}

function parseHistoryPageFailed(value: Fields): HistoryPageFailedMessage | undefined {
    const requestId = str(value.request_id);
    const reason = str(value.reason);
    if (requestId === undefined || reason === undefined) return undefined;
    return { type: "history_page_failed", requestId, reason };
}

function parseLive(type: string, value: Fields): LiveMessage | undefined {
    switch (type) {
        case "user_prompt": {
            const content = str(value.content);
            return content === undefined ? undefined : { type: "user_prompt", content };
        }
        case "assistant_delta": {
            const text = str(value.text);
            return text === undefined ? undefined : { type: "assistant_delta", text };
        }
        case "assistant_thinking": {
            const text = str(value.text);
            return text === undefined ? undefined : { type: "assistant_thinking", text };
        }
        case "tool_started": {
            const tool = str(value.tool);
            return tool === undefined
                ? undefined
                : { type: "tool_started", tool, args: isRecord(value.args) ? value.args : {} };
        }
        case "tool_finished": {
            const tool = str(value.tool);
            return tool === undefined
                ? undefined
                : { type: "tool_finished", tool, output: str(value.output), isError: value.isError === true };
        }
        case "turn_finished": {
            const modelFailure = parseModelFailure(value.modelFailure);
            const usage = parseUsage(value.usage);
            return {
                type: "turn_finished",
                outcome: outcomeOf(value.outcome),
                error: str(value.error),
                empty: value.empty === true,
                ...(modelFailure === undefined ? {} : { modelFailure }),
                ...(usage === undefined ? {} : { usage }),
            };
        }
        case "tool_presentation": {
            const tool = str(value.tool);
            const presentation = parsePresentation(value.presentation);
            if (tool === undefined || presentation === undefined) return undefined;
            return { type: "tool_presentation", tool, presentation };
        }
        case "model_substitution": {
            const substitution = parseSubstitution(value);
            if (substitution === undefined) return undefined;
            return { type: "model_substitution", substitution, source: value.source === "subagent" ? "subagent" : "turn" };
        }
        case "task_notification": {
            const delivery = parseDelivery(value, "kind");
            return delivery === undefined ? undefined : { type: "task_notification", delivery };
        }
        case "model_activity": {
            const retry = parseRetry(value);
            if (retry === undefined) return undefined;
            return { type: "model_retry", retry, replacesPartial: value.replacesPartialAttempt === true };
        }
        case "status": {
            const state = statusOf(value.state);
            return state === undefined ? undefined : { type: "status", state };
        }
        case "agent_failed": {
            const detail = str(value.detail);
            return detail === undefined ? undefined : { type: "agent_failed", detail };
        }
        default:
            return undefined;
    }
}

function parseEntry(raw: unknown): WireEntry {
    if (!isRecord(raw)) return OTHER;
    const base = { id: str(raw.id), recordedAt: finite(raw.recordedAt) };
    const body = str(raw.text);
    switch (raw.kind) {
        case "user":
            return body === undefined ? OTHER : { kind: "user", ...base, text: body };
        case "assistant":
            return body === undefined ? OTHER : { kind: "assistant", ...base, text: body };
        case "reasoning":
            return body === undefined ? OTHER : { kind: "reasoning", ...base, text: body };
        case "tool": {
            const tool = str(raw.tool);
            return tool === undefined ? OTHER : { kind: "tool", ...base, tool, args: isRecord(raw.args) ? raw.args : {} };
        }
        case "tool_result": {
            const tool = str(raw.tool);
            return tool === undefined
                ? OTHER
                : { kind: "tool_result", ...base, tool, output: str(raw.output) ?? "", isError: raw.isError === true };
        }
        case "error": {
            const modelFailure = parseModelFailure(raw.modelFailure);
            return {
                kind: "error",
                ...base,
                outcome: outcomeOf(raw.outcome),
                detail: str(raw.detail),
                ...(modelFailure === undefined ? {} : { modelFailure }),
            };
        }
        case "empty":
            return { kind: "empty", ...base };
        case "presentation": {
            const presentation = parsePresentation(raw.presentation);
            return presentation === undefined ? OTHER : { kind: "presentation", ...base, presentation };
        }
        case "model_substitution": {
            const substitution = parseSubstitution(raw.substitution);
            return substitution === undefined ? OTHER : { kind: "model_substitution", ...base, substitution };
        }
        case "delivery": {
            const delivery = parseDelivery(raw, "deliveryKind");
            return delivery === undefined ? OTHER : { kind: "delivery", ...base, delivery };
        }
        case "harness":
            return body === undefined ? OTHER : { kind: "harness", ...base, text: body, tone: str(raw.tone) ?? "" };
        default:
            return OTHER;
    }
}

function refused(requestId: string | undefined, content: string | undefined, reason: string | undefined): PromptRefusedMessage {
    return {
        type: "prompt_refused",
        ...(requestId === undefined ? {} : { requestId }),
        ...(content === undefined ? {} : { content }),
        reason: reason ?? "Vera did not take that message.",
    };
}

function queueOf(value: unknown): QueuedPrompt[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: QueuedPrompt[] = [];
    for (const item of value) {
        if (!isRecord(item) || typeof item.content !== "string") continue;
        out.push({ content: item.content, state: item.state === "released" ? "released" : "held" });
    }
    return out;
}

function entriesOf(value: unknown): WireEntry[] | undefined {
    return Array.isArray(value) ? value.map(parseEntry) : undefined;
}

function pageOf(value: unknown): PageInfo | undefined {
    if (!isRecord(value) || typeof value.hasMore !== "boolean") return undefined;
    const olderBefore = str(value.olderBefore);
    return olderBefore === undefined ? { hasMore: value.hasMore } : { hasMore: value.hasMore, olderBefore };
}

function statusOf(value: unknown): AgentRunStatus | undefined {
    return value === "idle" || value === "working" || value === "waiting" ? value : undefined;
}

function outcomeOf(value: unknown): "error" | "aborted" | undefined {
    return value === "error" || value === "aborted" ? value : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
