import { bg, fg, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import type { AgentUpdate, AttachmentRef } from "../../src/engine/protocol.ts";
import type { TranscriptEntry } from "../../src/engine/protocol.ts";
import type { ToolPresentation } from "../../src/model/types.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type {
    ApprovalMode,
    PermissionInspection,
} from "../../src/engine/permissions.ts";
import type { TuiTheme } from "./theme.ts";
import { VERA_TUI_THEME } from "./theme.ts";

export type TuiTranscriptEntryKind =
    | "user"
    | "assistant"
    | "tool"
    | "thought"
    | "review"
    | "notice"
    | "notification"
    | "diff";

export interface TuiTextTranscriptEntry {
    readonly kind: Exclude<TuiTranscriptEntryKind, "diff">;
    readonly text: string;
    /** What the user attached, named for the chips under a user entry. */
    readonly attachments?: readonly string[];
}

export interface TuiDiffTranscriptEntry {
    readonly kind: "diff";
    readonly text: string;
    readonly path: string;
    readonly patch: string;
}

export type TuiTranscriptEntry =
    | TuiTextTranscriptEntry
    | TuiDiffTranscriptEntry;

export interface TuiState {
    readonly entries: readonly TuiTranscriptEntry[];
    readonly working: boolean;
    readonly queuedPrompts: readonly string[];
    readonly modelSettings?: ModelTurnSettings;
    readonly approvalMode?: ApprovalMode;
    readonly permissionInspection?: PermissionInspection;
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

export function attachmentLabel(attachment: AttachmentRef): string {
    return attachment.name ?? "attached image";
}

/** True when an entry already shows this prompt and these attachments. */
export function userEntryShows(
    entry: TuiTranscriptEntry | undefined,
    text: string,
    attachments?: readonly AttachmentRef[],
): boolean {
    return entry?.kind === "user"
        && entry.text === text
        && sameAttachments(
            entryAttachments(entry),
            (attachments ?? []).map(attachmentLabel),
        );
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
    attachments?: readonly AttachmentRef[],
): TuiState {
    return {
        ...state,
        entries: [...state.entries, userEntry(prompt, attachments)],
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
            text: toolEntryText(state.entries, update.tool, update.args),
        });
    }
    if (update.type === "tool_review") {
        if (update.decision === "allow") {
            return appendEntry(state, {
                kind: "review",
                text: `Auto review approved ${update.tool}`
                    + ` (risk: ${update.riskLevel},`
                    + ` authorization: ${update.userAuthorization}):`
                    + ` ${update.reason}`,
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
    if (update.type === "tool_presentation") {
        return appendPresentation(state, update.presentation);
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
            kind: "notification",
            text: `Background agent ${update.sourceAgentId} completed:\n${update.content}`,
        });
    }
    if (update.type === "history") {
        const canonicalEntries = toTuiTranscriptEntries(update.entries);
        return {
            ...state,
            entries: preserveLiveReviewEntries(
                state.entries,
                canonicalEntries,
            ),
            ...(update.contextInputTokens === undefined
                ? {}
                : { contextInputTokens: update.contextInputTokens }),
        };
    }
    if (update.type === "user_prompt") {
        if (userEntryShows(state.entries.at(-1), update.content, update.attachments)) {
            return state;
        }
        return appendEntry(state, userEntry(update.content, update.attachments));
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
        // Every settings change is announced optimistically the moment it is
        // sent, so swallowing the refusal leaves the transcript claiming a
        // change that never happened. Only "invalid" is a refusal of what was
        // asked for: "unavailable" means the engine is not wired to answer
        // yet, which a reader can do nothing about and which fires during a
        // normal startup read.
        return update.reason === "invalid"
            ? appendTuiNotice(
                state,
                "model settings change rejected: that combination is not supported",
            )
            : state;
    }
    if (update.type === "permissions") {
        return {
            ...state,
            approvalMode: update.mode,
            ...(update.inspection === undefined
                ? {}
                : { permissionInspection: update.inspection }),
        };
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
    if (entry.kind === "diff") {
        return new StyledText([fg(TUI_MUTED)(entry.text)]);
    }
    if (entry.kind === "user") {
        const chunks: TextChunk[] = [];
        const lines = entry.text.length === 0 ? [] : entry.text.split("\n");
        lines.forEach((line, lineIndex) => {
            chunks.push(
                lineIndex === 0 ? fg(TUI_ACCENT)("▌ ") : fg(TUI_TEXT)("\n  "),
            );
            chunks.push(fg(TUI_TEXT)(line));
        });
        (entry.attachments ?? []).forEach((name, index) => {
            chunks.push(
                lines.length === 0 && index === 0
                    ? fg(TUI_ACCENT)("▌ ")
                    : fg(TUI_TEXT)("\n  "),
            );
            chunks.push(fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(" File ")));
            chunks.push(fg(TUI_MUTED)(` ${name}`));
        });
        return new StyledText(chunks);
    }
    if (entry.kind === "notice" || entry.kind === "review") {
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
    if (
        entry?.kind === "tool"
        && (
            previous?.kind === "tool"
            || previous?.kind === "review"
            || previous?.kind === "thought"
        )
    ) {
        return 0;
    }

    return 1;
}

const TOOL_SUMMARY_LIMIT = 2000;

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
    // A command wraps rather than being cut at a column, since what ran is the
    // part worth reading. The cap is far above any terminal width and bounds
    // only how much of a pathological argument one row can scroll off screen.
    return summary.length > TOOL_SUMMARY_LIMIT
        ? `${tool} ${summary.slice(0, TOOL_SUMMARY_LIMIT - 1)}…`
        : `${tool} ${summary}`;
}

/**
 * The gutter a tool row opens with. The first call of a run heads the group and
 * the rest hang off it, so a sequence of calls reads as one unit rather than as
 * n unrelated rows.
 */
function toolEntryText(
    entries: readonly TuiTranscriptEntry[],
    tool: string,
    args: Readonly<Record<string, unknown>>,
): string {
    // Review and thought rows come and go: a history checkpoint drops them,
    // and a run of calls has to head the same way either way, or the checkpoint
    // stops matching what is on screen.
    const previous = entries.findLast((entry) =>
        entry.kind !== "review" && entry.kind !== "thought"
    );
    return `${previous?.kind === "tool" ? "└ " : "∗ "}${formatToolCall(tool, args)}`;
}

function toTuiTranscriptEntries(
    entries: readonly TranscriptEntry[],
): TuiTranscriptEntry[] {
    const converted: TuiTranscriptEntry[] = [];
    for (const entry of entries) {
        converted.push(toTuiTranscriptEntry(entry, converted));
    }
    return converted;
}

function toTuiTranscriptEntry(
    entry: TranscriptEntry,
    preceding: readonly TuiTranscriptEntry[],
): TuiTranscriptEntry {
    if (entry.kind === "tool") {
        return {
            kind: "tool",
            text: toolEntryText(preceding, entry.tool, entry.args),
        };
    }
    if (entry.kind === "error") {
        return {
            kind: "notice",
            text: `Model error: ${entry.detail ?? "Model request failed"}`,
        };
    }
    if (entry.kind === "presentation") {
        return presentationEntry(entry.presentation);
    }
    return entry.kind === "user"
        ? userEntry(entry.text, entry.attachments)
        : entry;
}

function appendPresentation(
    state: TuiState,
    presentation: ToolPresentation,
): TuiState {
    return appendEntry(state, presentationEntry(presentation));
}

function presentationEntry(
    presentation: ToolPresentation,
): TuiTranscriptEntry {
    return presentation.kind === "unified_diff"
        ? {
            kind: "diff",
            text: presentation.path,
            path: presentation.path,
            patch: presentation.patch,
        }
        : { kind: "notice", text: presentation.text };
}

function userEntry(
    text: string,
    attachments?: readonly AttachmentRef[],
): TuiTextTranscriptEntry {
    const labels = (attachments ?? []).map(attachmentLabel);
    return {
        kind: "user",
        text,
        ...(labels.length === 0 ? {} : { attachments: labels }),
    };
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

function preserveLiveReviewEntries(
    current: readonly TuiTranscriptEntry[],
    canonical: readonly TuiTranscriptEntry[],
): readonly TuiTranscriptEntry[] {
    const withoutTransientEntries = current.filter((entry) =>
        entry.kind !== "review" && entry.kind !== "thought"
    );
    if (
        current.some((entry) => entry.kind === "review")
        && transcriptEntriesEqual(withoutTransientEntries, canonical)
    ) {
        return current.filter((entry) => entry.kind !== "thought");
    }
    return canonical;
}

function transcriptEntriesEqual(
    left: readonly TuiTranscriptEntry[],
    right: readonly TuiTranscriptEntry[],
): boolean {
    return left.length === right.length
        && left.every((entry, index) =>
            entry.kind === right[index]?.kind
            && entry.text === right[index]?.text
            && sameAttachments(
                entryAttachments(entry),
                entryAttachments(right[index]),
            )
            && (entry.kind !== "diff"
                || (right[index]?.kind === "diff"
                    && entry.patch === right[index].patch))
        );
}

function entryAttachments(
    entry: TuiTranscriptEntry | undefined,
): readonly string[] {
    return entry === undefined || entry.kind === "diff"
        ? []
        : entry.attachments ?? [];
}

function sameAttachments(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return left.length === right.length
        && left.every((name, index) => name === right[index]);
}

function assertNever(value: never): never {
    throw new Error(`Unhandled agent update: ${JSON.stringify(value)}`);
}
