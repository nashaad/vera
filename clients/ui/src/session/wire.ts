import type { AgentRunStatus } from "./model.ts";

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
    | HarnessEntry
    | OtherEntry;

export interface AttachedMessage {
    readonly type: "attached";
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
}

export interface StatusMessage {
    readonly type: "status";
    readonly state: AgentRunStatus;
}

export interface AgentFailedMessage {
    readonly type: "agent_failed";
    readonly detail: string;
}

export type LiveMessage =
    | UserPromptMessage
    | AssistantDeltaMessage
    | AssistantThinkingMessage
    | ToolStartedMessage
    | ToolFinishedMessage
    | TurnFinishedMessage
    | StatusMessage
    | AgentFailedMessage;

export type SessionMessage =
    | AttachedMessage
    | AttachFailedMessage
    | HistoryMessage
    | HistoryPageMessage
    | HistoryPageFailedMessage
    | SessionTitleMessage
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

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function parseMessage(type: string, value: Fields): SessionMessage | undefined {
    switch (type) {
        case "attached":
            return { type: "attached" };
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
    return { type: "history", entries, status: statusOf(value.status), page: pageOf(value.page) };
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
        case "turn_finished":
            return { type: "turn_finished", outcome: outcomeOf(value.outcome), error: str(value.error) };
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
        case "error":
            return { kind: "error", ...base, outcome: outcomeOf(raw.outcome), detail: str(raw.detail) };
        case "harness":
            return body === undefined ? OTHER : { kind: "harness", ...base, text: body, tone: str(raw.tone) ?? "" };
        default:
            return OTHER;
    }
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
