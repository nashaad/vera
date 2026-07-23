import { fg, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { TranscriptEntry } from "../../src/engine/protocol.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { TuiTheme } from "./theme.ts";
import { VERA_TUI_THEME } from "./theme.ts";

export type TuiTranscriptEntryKind =
    | "user"
    | "assistant"
    | "tool"
    | "thought"
    | "notice";

export interface TuiTranscriptEntry {
    readonly kind: TuiTranscriptEntryKind;
    readonly text: string;
}

export interface TuiState {
    readonly entries: readonly TuiTranscriptEntry[];
    readonly working: boolean;
    readonly queuedPrompts: readonly string[];
    readonly modelSettings?: ModelTurnSettings;
    readonly approvalMode?: ApprovalMode;
    readonly contextInputTokens?: number;
}

export let TUI_ACCENT = VERA_TUI_THEME.accent;
export let TUI_TEXT = VERA_TUI_THEME.text;
export let TUI_MUTED = VERA_TUI_THEME.muted;
export let TUI_NOTICE = VERA_TUI_THEME.notice;
export let TUI_SUCCESS = VERA_TUI_THEME.success;
export let TUI_BACKGROUND = VERA_TUI_THEME.background;
export let TUI_PANEL = VERA_TUI_THEME.panel;
export let TUI_ELEMENT = VERA_TUI_THEME.element;

export function applyTuiTheme(theme: TuiTheme): void {
    TUI_ACCENT = theme.accent;
    TUI_TEXT = theme.text;
    TUI_MUTED = theme.muted;
    TUI_NOTICE = theme.notice;
    TUI_SUCCESS = theme.success;
    TUI_BACKGROUND = theme.background;
    TUI_PANEL = theme.panel;
    TUI_ELEMENT = theme.element;
}

export function createTuiState(): TuiState {
    return {
        entries: [],
        working: false,
        queuedPrompts: [],
    };
}

export function beginTuiTurn(
    state: TuiState,
    prompt: string,
    attachmentIds?: readonly string[],
): TuiState {
    return {
        ...state,
        entries: [...state.entries, {
            kind: "user",
            text: displayUserPrompt(prompt, attachmentIds),
        }],
        working: true,
    };
}

export function queueTuiPrompt(state: TuiState, prompt: string): TuiState {
    return {
        ...state,
        queuedPrompts: [...state.queuedPrompts, prompt],
    };
}

export function beginNextQueuedTuiTurn(state: TuiState): TuiState {
    const [prompt, ...queuedPrompts] = state.queuedPrompts;
    if (prompt === undefined) {
        return state;
    }

    return {
        ...state,
        entries: [...state.entries, { kind: "user", text: prompt }],
        working: true,
        queuedPrompts,
    };
}

export function renderTuiQueuedPrompt(state: TuiState): string {
    const prompt = state.queuedPrompts[0];
    if (prompt === undefined) {
        return "";
    }

    const summary = prompt.replace(/\s+/g, " ").trim();
    const compact = summary.length > 48
        ? `${summary.slice(0, 47)}…`
        : summary;
    const remaining = state.queuedPrompts.length - 1;
    return `queued · ${compact}${remaining === 0 ? "" : ` · +${remaining}`}`;
}

export function applyAgentUpdate(state: TuiState, update: AgentUpdate): TuiState {
    if (update.type === "assistant_delta") {
        return appendAssistantText(state, update.text);
    }
    if (update.type === "tool_started") {
        return appendEntry(state, {
            kind: "tool",
            text: `∗ ${formatToolCall(update.tool, update.args)}`,
        });
    }
    if (update.type === "tool_review") {
        // Allowed reviews stay in the compact tool run; anything else stands
        // out. The risk level rides along because "denied" alone does not say
        // whether the reviewer saw something dangerous or just got confused,
        // and an unavailable reviewer scored nothing at all.
        if (update.decision === "allow") {
            return appendEntry(state, {
                kind: "tool",
                text: `∗ reviewer allowed ${update.tool}`
                    + ` (${update.riskLevel} risk): ${update.reason}`,
            });
        }
        return appendEntry(state, {
            kind: "notice",
            text: update.decision === "deny"
                ? `Reviewer denied ${update.tool}`
                    + ` (${update.riskLevel} risk): ${update.reason}`
                : `Reviewer unavailable for ${update.tool}: ${update.reason}`,
        });
    }
    if (update.type === "tool_finished") {
        return state;
    }
    if (update.type === "turn_finished") {
        const finished = {
            ...state,
            working: false,
            ...(update.contextInputTokens === undefined
                ? {}
                : { contextInputTokens: update.contextInputTokens }),
        };
        const error = update.error
            ?? (update.outcome === "error" ? "Model request failed"
                : update.outcome === "aborted" ? "Turn aborted"
                : undefined);
        return error === undefined
            ? finished
            : appendEntry(finished, {
                kind: "notice",
                text: error.startsWith("Image attachment unavailable:")
                    ? `Attachment error: ${error.slice("Image attachment unavailable:".length).trim()}`
                    : `Model error: ${error}`,
            });
    }
    if (update.type === "agent_failed") {
        return appendEntry({
            ...state,
            working: false,
            queuedPrompts: [],
        }, {
            kind: "notice",
            text: `Agent error: ${update.detail}`,
        });
    }
    if (update.type === "status") {
        return { ...state, working: update.state !== "idle" };
    }
    if (update.type === "task_notification") {
        return appendEntry(state, {
            kind: "notice",
            text: `Background agent ${update.sourceAgentId} completed:\n${update.content}`,
        });
    }
    if (update.type === "history") {
        return {
            ...state,
            entries: update.entries.map(toTuiTranscriptEntry),
            ...(update.contextInputTokens === undefined
                ? {}
                : { contextInputTokens: update.contextInputTokens }),
        };
    }
    if (update.type === "user_prompt") {
        const text = displayUserPrompt(update.content, update.attachmentIds);
        const last = state.entries.at(-1);
        if (last?.kind === "user" && last.text === text) {
            return state;
        }
        return appendEntry(state, { kind: "user", text });
    }
    if (update.type === "ui_request") {
        return state;
    }
    if (update.type === "ui_request_closed") {
        return state;
    }
    if (update.type === "model_settings") {
        return { ...state, modelSettings: update.settings };
    }
    if (update.type === "model_settings_rejected") {
        return state;
    }
    if (update.type === "permissions") {
        return { ...state, approvalMode: update.mode };
    }
    if (update.type === "permissions_rejected") {
        return state;
    }
    if (
        update.type === "session_name"
        || update.type === "session_name_rejected"
    ) {
        return state;
    }
    if (
        update.type === "timeline"
        || update.type === "timeline_action_preview"
        || update.type === "timeline_action_applied"
        || update.type === "timeline_action_rejected"
    ) {
        return state;
    }
    if (
        update.type === "image_attached"
        || update.type === "image_attachment_rejected"
    ) {
        return state;
    }
    return assertNever(update);
}

export function appendTuiNotice(state: TuiState, message: string): TuiState {
    return appendEntry(state, { kind: "notice", text: message });
}

export function failTuiConnection(state: TuiState, message: string): TuiState {
    return appendTuiNotice({
        ...state,
        working: false,
        queuedPrompts: [],
    }, `Connection error: ${message}`);
}

export function appendTuiThought(state: TuiState, seconds: number): TuiState {
    return appendEntry(state, {
        kind: "thought",
        text: `+ Thought: ${seconds.toFixed(1)}s`,
    });
}

export function renderTuiEntry(entry: TuiTranscriptEntry): StyledText {
    if (entry.kind === "user") {
        const chunks: TextChunk[] = [];
        entry.text.split("\n").forEach((line, lineIndex) => {
            if (lineIndex > 0) {
                chunks.push(fg(TUI_TEXT)("\n  "));
            } else {
                chunks.push(fg(TUI_ACCENT)("▌ "));
            }
            chunks.push(fg(TUI_TEXT)(line));
        });
        return new StyledText(chunks);
    }
    if (entry.kind === "notice") {
        return new StyledText([fg(TUI_NOTICE)(entry.text)]);
    }
    if (entry.kind === "thought") {
        return new StyledText([fg(TUI_NOTICE)(entry.text)]);
    }
    return new StyledText([fg(TUI_MUTED)(entry.text)]);
}

export function tuiEntryMarginTop(
    entries: readonly TuiTranscriptEntry[],
    index: number,
): number {
    if (index === 0) {
        return 0;
    }

    const entry = entries[index];
    const previous = entries[index - 1];
    if (entry?.kind === "tool" && previous?.kind === "tool") {
        return 0;
    }

    return 1;
}

function formatToolCall(
    tool: string,
    args: Readonly<Record<string, unknown>>,
): string {
    const summary = Object.values(args)
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    if (summary.length === 0) {
        return tool;
    }
    return `${tool} ${summary.length > 64 ? `${summary.slice(0, 63)}…` : summary}`;
}

function toTuiTranscriptEntry(entry: TranscriptEntry): TuiTranscriptEntry {
    if (entry.kind === "tool") {
        return {
            kind: "tool",
            text: `∗ ${formatToolCall(entry.tool, entry.args)}`,
        };
    }
    if (entry.kind === "error") {
        return {
            kind: "notice",
            text: `Model error: ${entry.detail ?? "Model request failed"}`,
        };
    }
    return entry.kind === "user"
        ? { kind: "user", text: displayUserPrompt(entry.text, entry.attachmentIds) }
        : entry;
}

function displayUserPrompt(text: string, attachmentIds?: readonly string[]): string {
    if (attachmentIds === undefined || attachmentIds.length === 0) return text;
    const labels = attachmentIds.map(() => "[Attached image]").join("\n");
    return text.length === 0 ? labels : `${text}\n${labels}`;
}

function appendAssistantText(state: TuiState, text: string): TuiState {
    const entries = [...state.entries];
    const lastEntry = entries.at(-1);

    if (lastEntry?.kind === "assistant") {
        entries[entries.length - 1] = {
            kind: "assistant",
            text: lastEntry.text + text,
        };
    } else {
        entries.push({ kind: "assistant", text });
    }

    return { ...state, entries };
}

function appendEntry(state: TuiState, entry: TuiTranscriptEntry): TuiState {
    return { ...state, entries: [...state.entries, entry] };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled agent update: ${JSON.stringify(value)}`);
}
