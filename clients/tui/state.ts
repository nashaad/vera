import { fg, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { TranscriptEntry } from "../../src/engine/protocol.ts";

export type TuiTranscriptEntryKind = "user" | "assistant" | "tool" | "notice";

export interface TuiTranscriptEntry {
    readonly kind: TuiTranscriptEntryKind;
    readonly text: string;
}

export interface TuiState {
    readonly entries: readonly TuiTranscriptEntry[];
    readonly working: boolean;
    readonly queuedPrompts: readonly string[];
}

export const TUI_ACCENT = "#7AA2F7";
export const TUI_TEXT = "#D5DAE2";
export const TUI_MUTED = "#5C6370";
export const TUI_NOTICE = "#E0AF68";

export function createTuiState(): TuiState {
    return {
        entries: [],
        working: false,
        queuedPrompts: [],
    };
}

export function beginTuiTurn(state: TuiState, prompt: string): TuiState {
    return {
        entries: [...state.entries, { kind: "user", text: prompt }],
        working: true,
        queuedPrompts: state.queuedPrompts,
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
    if (update.type === "tool_finished") {
        return state;
    }
    if (update.type === "turn_finished") {
        return { ...state, working: false };
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
        };
    }
    if (update.type === "user_prompt") {
        const last = state.entries.at(-1);
        if (last?.kind === "user" && last.text === update.content) {
            return state;
        }
        return appendEntry(state, { kind: "user", text: update.content });
    }
    if (update.type === "ui_request") {
        return state;
    }
    if (update.type === "ui_request_closed") {
        return state;
    }
    return assertNever(update);
}

export function appendTuiNotice(state: TuiState, message: string): TuiState {
    return appendEntry(state, { kind: "notice", text: message });
}

export function renderTuiEntry(entry: TuiTranscriptEntry): StyledText {
    if (entry.kind === "user") {
        const chunks: TextChunk[] = [];
        entry.text.split("\n").forEach((line, lineIndex) => {
            if (lineIndex > 0) {
                chunks.push(fg(TUI_TEXT)("\n"));
            }
            chunks.push(fg(TUI_ACCENT)("▌ "), fg(TUI_TEXT)(line));
        });
        return new StyledText(chunks);
    }
    if (entry.kind === "notice") {
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
    return entry;
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
