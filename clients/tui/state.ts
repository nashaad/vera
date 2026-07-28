import { bg, fg, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import type { AgentUpdate, AttachmentRef } from "../../src/engine/protocol.ts";
import type {
    CompactionUpdate,
    TranscriptEntry,
} from "../../src/engine/protocol.ts";
import type { ToolPresentation } from "../../src/model/types.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
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
    | "tool_header"
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
    /** Which group a tool row belongs to, and what its header reads. */
    readonly header?: string;
    /** The gutter drawn left of a tool row, in its own column. */
    readonly prefix?: string;
    /** How many times in a row the same call was made. */
    readonly repeat?: number;
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
    readonly context?: ContextMeasurement;
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
        return {
            ...state,
            entries: withToolEntry(state.entries, update.tool, update.args),
        };
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
        const finished = { ...state, working: false };
        if (update.empty === true) {
            return appendEntry(finished, emptyTurnEntry());
        }
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
            text: `Async subagent ${update.sourceAgentId}:\n${update.content}`,
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
            ...(update.context === undefined
                ? {}
                : { context: update.context }),
        };
    }
    if (update.type === "context") {
        return { ...state, context: update.measurement };
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
    if (update.type === "compaction") {
        return applyCompaction(state, update);
    }
    return assertNever(update);
}

/**
 * The transcript above the horizon still reads in full, but the model can no
 * longer see it, and only this line says so. A failure is shown for the same
 * reason: the session keeps working, so nothing else would reveal that the
 * context did not get any smaller.
 */
function applyCompaction(
    state: TuiState,
    update: CompactionUpdate,
): TuiState {
    if (update.phase === "started") {
        return state;
    }
    if (update.outcome === "compacted") {
        return appendTuiNotice(
            state,
            "Earlier messages were summarized. They are still shown here, but "
                + "the model now sees the summary instead.",
        );
    }
    if (update.outcome === "busy") {
        return appendTuiNotice(
            state,
            "Compaction runs between turns. Try again once this one finishes.",
        );
    }
    if (update.outcome === "not_needed") {
        // Reached only when the model's context window is unknown, since a
        // manual request otherwise skips the trigger check.
        return appendTuiNotice(
            state,
            "Could not summarize: the model's context window is not known, "
                + "so there is no size to summarize down to.",
        );
    }
    if (update.outcome === "no_boundary") {
        return appendTuiNotice(
            state,
            `Nothing to summarize yet${
                update.reason === undefined ? "" : `: ${update.reason}`
            }`,
        );
    }
    if (update.outcome === "rejected" || update.outcome === "unavailable") {
        return appendTuiNotice(
            state,
            `Could not summarize the earlier messages${
                update.reason === undefined ? "" : `: ${update.reason}`
            }`,
        );
    }
    return state;
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
        // The band around a user message is chrome the renderer draws, so the
        // text itself carries no marker.
        return new StyledText([fg(TUI_TEXT)(entry.text)]);
    }
    if (entry.kind === "tool_header") {
        return new StyledText([fg(TUI_ACCENT)(entry.text)]);
    }
    if (entry.kind === "tool") {
        return new StyledText([
            fg(TUI_MUTED)(`${entry.prefix ?? ""}${tuiToolRowText(entry)}`),
        ]);
    }
    if (entry.kind === "notice" || entry.kind === "review") {
        return new StyledText([fg(TUI_NOTICE)(entry.text)]);
    }
    if (entry.kind === "thought") {
        return new StyledText([fg(TUI_NOTICE)(entry.text)]);
    }
    return new StyledText([fg(TUI_MUTED)(entry.text)]);
}

/** A row's text, carrying the count when the same call repeated. */
export function tuiToolRowText(entry: TuiTextTranscriptEntry): string {
    const repeat = entry.repeat ?? 1;
    return repeat > 1 ? `${entry.text} ×${repeat}` : entry.text;
}

export function tuiEntryMarginTop(
    entries: readonly TuiTranscriptEntry[],
    index: number,
): number {
    if (index === 0) {
        return 0;
    }

    // Rows inside a group sit flush under their header. Everything else, the
    // header included, opens with one blank line.
    return entries[index]?.kind === "tool" ? 0 : 1;
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

const TOOL_HEADERS: Readonly<Record<string, string>> = {
    read: "Explored",
    grep: "Explored",
    list: "Explored",
    bash: "Ran",
    edit: "Edited",
    write: "Edited",
    subagent: "Delegated",
    async_subagent: "Delegated",
    ask_user: "Asked",
};

function bounded(value: string): string {
    return value.length > TOOL_SUMMARY_LIMIT
        ? `${value.slice(0, TOOL_SUMMARY_LIMIT - 1)}…`
        : value;
}

function toolHeader(tool: string): string {
    return TOOL_HEADERS[tool] ?? "Worked";
}

function stringArg(
    args: Readonly<Record<string, unknown>>,
    name: string,
): string | undefined {
    const value = args[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The workspace-relative path, since the absolute prefix is the same on every row. */
function displayPath(path: string): string {
    const workspace = `${process.cwd()}/`;
    return path.startsWith(workspace) ? path.slice(workspace.length) : path;
}

/**
 * What a call did, in the tool's own terms. The generic name-plus-arguments
 * form stays as the fallback for a tool this client has never heard of.
 */
function toolRowText(
    tool: string,
    args: Readonly<Record<string, unknown>>,
): string {
    const path = stringArg(args, "path");
    if (tool === "read" && path !== undefined) {
        return `Read ${displayPath(path)}`;
    }
    if (tool === "list" && path !== undefined) {
        return `List ${displayPath(path)}`;
    }
    if (tool === "grep") {
        const pattern = stringArg(args, "pattern");
        if (pattern !== undefined) {
            return path === undefined
                ? `Search ${pattern}`
                : `Search ${pattern} in ${displayPath(path)}`;
        }
    }
    if (tool === "bash") {
        const command = stringArg(args, "command");
        if (command !== undefined) {
            // A command keeps its own lines. Flattening a script into one
            // paragraph loses where each command ended.
            return bounded(command.replaceAll(/[ \t]+$/gm, "").trim());
        }
    }
    if ((tool === "edit" || tool === "write") && path !== undefined) {
        return `${tool === "edit" ? "Edit" : "Write"} ${displayPath(path)}`;
    }
    if (tool === "subagent" || tool === "async_subagent") {
        const description = stringArg(args, "description");
        if (description !== undefined) {
            return bounded(description.replaceAll(/\s+/g, " ").trim());
        }
    }
    return formatToolCall(tool, args);
}

/**
 * The transcript a call leaves behind. A call either repeats the one above it,
 * joins the run above it, or opens a new group with a header, so a sequence of
 * calls reads as one unit rather than as n unrelated rows.
 */
function withToolEntry(
    entries: readonly TuiTranscriptEntry[],
    tool: string,
    args: Readonly<Record<string, unknown>>,
): TuiTranscriptEntry[] {
    // Review and thought rows come and go: a history checkpoint drops them, and
    // a run has to group the same way either way, or the checkpoint stops
    // matching what is on screen.
    const previousIndex = entries.findLastIndex((entry) =>
        entry.kind !== "review" && entry.kind !== "thought"
    );
    const previous = entries[previousIndex];
    const header = toolHeader(tool);
    const row = toolRowText(tool, args);
    if (
        previous?.kind === "tool"
        && previous.header === header
        && previous.text === row
    ) {
        const repeated: TuiTranscriptEntry = {
            ...previous,
            repeat: (previous.repeat ?? 1) + 1,
        };
        return entries.map((entry, index) =>
            index === previousIndex ? repeated : entry
        );
    }
    const open = (previous?.kind === "tool" || previous?.kind === "tool_header")
        && previous.header === header;
    if (open) {
        return [...entries, {
            kind: "tool",
            header,
            prefix: previous?.kind === "tool_header" ? "  └ " : "    ",
            text: row,
        }];
    }
    return [
        ...entries,
        { kind: "tool_header", header, text: header },
        { kind: "tool", header, prefix: "  └ ", text: row },
    ];
}

function toTuiTranscriptEntries(
    entries: readonly TranscriptEntry[],
): TuiTranscriptEntry[] {
    let converted: TuiTranscriptEntry[] = [];
    for (const entry of entries) {
        converted = entry.kind === "tool"
            ? withToolEntry(converted, entry.tool, entry.args)
            : [...converted, toSingleTuiTranscriptEntry(entry)];
    }
    return converted;
}

function toSingleTuiTranscriptEntry(
    entry: Exclude<TranscriptEntry, { kind: "tool" }>,
): TuiTranscriptEntry {
    if (entry.kind === "error") {
        return {
            kind: "notice",
            text: `Model error: ${entry.detail ?? "Model request failed"}`,
        };
    }
    if (entry.kind === "presentation") {
        return presentationEntry(entry.presentation);
    }
    if (entry.kind === "empty") {
        return emptyTurnEntry();
    }
    return entry.kind === "user"
        ? userEntry(entry.text, entry.attachments)
        : entry;
}

/**
 * The one place the wording lives, so the live turn and the same turn rebuilt
 * from history cannot drift apart.
 */
function emptyTurnEntry(): TuiTranscriptEntry {
    return { kind: "notice", text: "No response" };
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
