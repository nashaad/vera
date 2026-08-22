import { realpathSync } from "node:fs";

import { bg, bold, fg, italic, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import type { AgentUpdate, AttachmentRef } from "../../src/engine/protocol.ts";
import { formatModelSubstitution } from "../../src/engine/protocol.ts";
import type {
    CompactionUpdate,
    ModelActivityUpdate,
    PoolAdmissionProgressUpdate,
    PoolAdmissionResultUpdate,
    SessionModelUsage,
    TranscriptEntry,
} from "../../src/engine/protocol.ts";
import type { PoolAdmissionVerdict } from "../../src/engine/events.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";
import type { ToolPresentation } from "../../src/model/types.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type {
    ApprovalMode,
    PermissionInspection,
} from "../../src/engine/permissions.ts";
import type { TuiTheme, TuiThemeHud } from "./theme.ts";
import type { ModelSubstitution } from "../../src/model/types.ts";
import { tuiKeyChord, tuiKeyHint } from "./keymap.ts";
import {
    resolveTuiDiagnostic,
    type TuiDiagnostic,
    type TuiDiagnosticCode,
} from "./diagnostic-severity.ts";

/** Marks the rows where the turn ran on something other than what was asked. */
const SUBSTITUTION_MARKER = "\u21c4";
const INTERRUPTED_TURN_TEXT = "Interrupted";
import { VERA_TUI_THEME } from "./theme.ts";

export type TuiTranscriptEntryKind =
    | "user"
    | "assistant"
    | "tool"
    | "tool_header"
    | "thinking"
    | "thought"
    | "review"
    | "notice"
    | "inbox"
    | "notification"
    | "extension_label"
    | "substitution"
    | "diff";

export interface TuiTextTranscriptEntry {
    readonly kind: Exclude<TuiTranscriptEntryKind, "diff">;
    readonly text: string;
    /**
     * The store entry this row came from, on the rows that came from one.
     * The same reference resume and rewind take, which is what lets a client
     * open a conversation at a particular message rather than at its end.
     */
    readonly entryId?: string;
    /** What the user attached, named for the chips under a user entry. */
    readonly attachments?: readonly string[];
    /** Which group a tool row belongs to, and what its header reads. */
    readonly header?: string;
    /** The engine tool name, retained while its live row waits to finish. */
    readonly tool?: string;
    /** Whether this tool call is still executing. */
    readonly active?: boolean;
    /** Whether this row closes a tool call with its result. */
    readonly result?: boolean;
    /** Whether replay has paired this call with its durable result row. */
    readonly hasResult?: boolean;
    /** How many leading characters an extension injected; drawn muted. */
    readonly dimmedPrefix?: number;
    /** The gutter drawn left of a tool row, in its own column. */
    readonly prefix?: string;
    /** How many times in a row the same call or diagnostic occurred. */
    readonly repeat?: number;
    /**
     * What this notice is a receipt for. A second receipt under the same key
     * overwrites the first: cycling four themes is one decision, and only the
     * one that stuck is worth a line.
     */
    readonly supersedes?: string;
    /** Client-only row preserved across canonical history rebuilds. */
    readonly liveOnly?: boolean;
    /** The reasoning a `thought` summary folds away. */
    readonly reasoning?: string;
    /** How long a `thought` summary reports, in seconds. */
    readonly seconds?: number;
    /** Whether a `thought` summary is showing its reasoning. */
    readonly expanded?: boolean;
    /** Whether this completed tool row is hidden behind its group header. */
    readonly hidden?: boolean;
    /** How many logical output lines a folded tool header summarizes. */
    readonly detailLines?: number;
    /** The one summary line a folded tool group keeps. */
    readonly detailPreview?: string;
    /** Whether a short folded preview shares the header row. */
    readonly inlineDetailPreview?: boolean;
    /** The call a folded group shows on its own header row. */
    readonly command?: string;
    /** Whether this header carries the detail-toggle hint. */
    readonly hint?: boolean;
    /**
     * The `pool_add` request this checklist entry reports on. Progress updates
     * rewrite the entry in place rather than appending, so the checklist reads
     * as one live surface instead of one line per state change.
     */
    readonly admission?: string;
    /** A client/runtime event whose code fixes its severity and presentation. */
    readonly diagnostic?: TuiDiagnostic;
    /** Semantic emphasis for harness-authored transcript prose. */
    readonly tone?: "primary" | "soft" | "error";
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

/**
 * The reasoning level a turn actually ran at, when that is not the level the
 * user asked for.
 *
 * The requested level stays the user's own setting: a provider refusing it once
 * is not a reason to rewrite their dial. This is the evidence beside it, which
 * is what lets the status line say both at once.
 */
export interface TuiEffortSubstitution {
    readonly model: string;
    readonly requested: string;
    /** Absent when the turn ran with no reasoning level at all. */
    readonly effective?: string;
}

export interface TuiState {
    readonly entries: readonly TuiTranscriptEntry[];
    readonly working: boolean;
    readonly queuedPrompts: readonly string[];
    readonly modelSettings?: ModelTurnSettings;
    readonly approvalMode?: ApprovalMode;
    readonly permissionInspection?: PermissionInspection;
    readonly context?: ContextMeasurement;
    readonly modelActivity?: ModelActivityUpdate;
    readonly sessionUsage?: SessionModelUsage;
    /**
     * Reasoning streamed so far this phase, held off the transcript until the
     * phase ends. Keeping it out of `entries` is what stops a history rebuild
     * from having to preserve a row that has no backing message.
     */
    readonly pendingThinking?: string;
    /**
     * The substitution the status line reports beside the requested level. It
     * lasts as long as the evidence does: a new model, a new requested level,
     * or a turn that ran at the requested level clears it.
     */
    readonly effortSubstitution?: TuiEffortSubstitution;
    /**
     * Whether the running turn has already substituted. A turn that finishes
     * without one is what says the requested level works again.
     */
    readonly turnSubstituted?: boolean;
    /**
     * The model this turn actually ran on, when the parent turn fell back.
     *
     * Transient by construction: the committed pair is unchanged and retried
     * next turn, so this is cleared when the parent turn ends rather than
     * carried. A subagent's own fallback never lands here.
     */
    readonly modelFallback?: { readonly from: string; readonly to: string };
    /** Whether new `thought` summaries open showing their reasoning. */
    readonly thinkingExpanded?: boolean;
    /** Whether completed tool groups are forced open or closed. */
    readonly toolDetailsExpanded?: boolean;
    /** The admission run in flight, or awaiting its refreshed pool snapshot. */
    readonly admission?: TuiAdmissionState;
    /**
     * Every pair this session has held, oldest first, as the host reported it.
     *
     * The dial strip derives its recents from this. Derived rather than
     * remembered: a list of its own could disagree with the session file, and
     * the session file is the thing that actually decides what the turn runs.
     */
    readonly modelSettingsHistory?: readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: "agent-default" | "user";
        readonly timestamp: string;
    }[];
    /** Where the pair in force came from, when the host has said. */
    readonly modelSettingsOrigin?: "agent-default" | "user";
    /** Where the posture in force came from, when the host has said. */
    readonly approvalModeOrigin?: "agent-default" | "user";
    /**
     * When the running compaction started. Compaction is otherwise silent
     * until its outcome, so this is what lets the status line show it working
     * instead of looking like a hang.
     */
    readonly compactingSince?: number;
    /** The strategy and first model in the bound summarizer route. */
    readonly compactionStrategy?: string;
    readonly compactionProvider?: string;
    readonly compactionModel?: string;
    /** The agent this session is wearing, as the host last reported it. */
    readonly agent?: {
        readonly name: string;
        readonly tools?: readonly string[];
        readonly skills?: readonly string[];
        readonly posture?: string;
        readonly forbiddenAccess?: readonly string[];
    };
}

export interface TuiAdmissionStep {
    readonly step: string;
    readonly label: string;
    readonly status: "running" | "passed" | "failed" | "skipped";
    readonly detail?: string;
}

/**
 * One `pool_add` as the transcript shows it: the subject line, the steps seen
 * so far, and the verdict once it lands. Kept on `TuiState` rather than only in
 * the entry text so a later `model_settings` snapshot can finish the "added"
 * line with the verified level count, which only that snapshot knows.
 */
export interface TuiAdmissionState {
    readonly requestId: string;
    readonly subject: string;
    readonly steps: readonly TuiAdmissionStep[];
    readonly verdict?: PoolAdmissionVerdict;
    readonly provider?: string;
    readonly model?: string;
    readonly reason?: string;
    readonly statusCode?: number;
    /** How many levels the refreshed pool snapshot reported as verified. */
    readonly verifiedLevels?: number;
    /**
     * Nothing more will arrive for this run. Kept rather than cleared so a
     * surface still showing the verdict has data to render; a new run
     * replaces it.
     */
    readonly settled?: boolean;
}

export let TUI_ACCENT = VERA_TUI_THEME.accent;
export let TUI_TEXT = VERA_TUI_THEME.text;
export let TUI_MUTED = VERA_TUI_THEME.muted;
export let TUI_NOTICE = VERA_TUI_THEME.notice;
export let TUI_DANGER = VERA_TUI_THEME.danger;
export let TUI_SUCCESS = VERA_TUI_THEME.success;
export let TUI_DIFF_ADDED = VERA_TUI_THEME.diffAdded;
export let TUI_DIFF_REMOVED = VERA_TUI_THEME.diffRemoved;
export let TUI_BACKGROUND = VERA_TUI_THEME.background;
export let TUI_PANEL = VERA_TUI_THEME.panel;
export let TUI_ELEMENT = VERA_TUI_THEME.element;
export let TUI_INPUT = VERA_TUI_THEME.input;
export let TUI_MENU = VERA_TUI_THEME.menu;
export let TUI_CHROME: "plain" | "norton" = "plain";
export let TUI_SELECTION_TEXT = VERA_TUI_THEME.selectionText;
export let TUI_HUD: TuiThemeHud | undefined = VERA_TUI_THEME.hud;

export function applyTuiTheme(theme: TuiTheme): void {
    TUI_ACCENT = theme.accent;
    TUI_TEXT = theme.text;
    TUI_MUTED = theme.muted;
    TUI_NOTICE = theme.notice;
    TUI_DANGER = theme.danger;
    TUI_SUCCESS = theme.success;
    TUI_DIFF_ADDED = theme.diffAdded;
    TUI_DIFF_REMOVED = theme.diffRemoved;
    TUI_BACKGROUND = theme.background;
    TUI_PANEL = theme.panel;
    TUI_ELEMENT = theme.element;
    TUI_INPUT = theme.input;
    TUI_MENU = theme.menu;
    TUI_CHROME = theme.chrome;
    TUI_SELECTION_TEXT = theme.selectionText;
    TUI_HUD = theme.hud;
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
    dimmedPrefix?: number,
): TuiState {
    return {
        ...state,
        entries: [...state.entries, userEntry(prompt, attachments, dimmedPrefix)],
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
    if (update.type === "model_activity") {
        return { ...state, modelActivity: update };
    }
    if (update.type === "assistant_delta") {
        return appendAssistantText(state, update.text);
    }
    if (update.type === "assistant_thinking") {
        return appendThinkingText(state, update.text);
    }
    if (update.type === "tool_started") {
        return {
            ...state,
            entries: withToolEntry(state.entries, update.tool, update.args, true),
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
        const message = update.decision === "deny"
            ? `Reviewer denied ${update.tool}`
                + ` (${update.riskLevel} risk): ${update.reason}`
            : `Reviewer unavailable for ${update.tool}: ${update.reason}`;
        return appendTuiDiagnostic(
            state,
            update.decision === "deny" ? "permission_denied" : "unknown",
            message,
        );
    }
    if (update.type === "tool_finished") {
        return {
            ...state,
            entries: applyToolDetailPreference(
                finishToolEntry(state.entries, update.tool, update.output),
                state.toolDetailsExpanded,
            ),
        };
    }
    if (update.type === "tool_presentation") {
        return appendPresentation(state, update.presentation);
    }
    if (update.type === "turn_finished") {
        const finished = clearedSubstitution({
            ...state,
            entries: settleTrailingThoughts(applyToolDetailPreference(
                settleToolEntries(state.entries),
                state.toolDetailsExpanded,
            )),
            working: false,
            modelActivity: undefined,
            compactingSince: undefined,
            compactionStrategy: undefined,
            compactionProvider: undefined,
            compactionModel: undefined,
            ...(update.usage === undefined
                ? {}
                : { sessionUsage: update.usage }),
        });
        if (update.empty === true) {
            return appendEntry(finished, emptyTurnEntry());
        }
        if (update.outcome === "aborted") {
            return appendTuiDiagnostic(
                finished,
                "turn_interrupted",
                INTERRUPTED_TURN_TEXT,
            );
        }
        const error = update.error
            ?? (update.outcome === "error" ? "Model request failed" : undefined);
        if (error === undefined) return finished;
        const attachment = error.startsWith("Image attachment unavailable:");
        return appendTuiDiagnostic(
            finished,
            attachment ? "attachment_failed" : "model_request_failed",
            attachment
                ? `Attachment error: ${error.slice("Image attachment unavailable:".length).trim()}`
                : `Model error: ${error}`,
        );
    }
    if (update.type === "agent_failed") {
        return appendTuiDiagnostic({
            ...state,
            entries: applyToolDetailPreference(
                settleToolEntries(state.entries),
                state.toolDetailsExpanded,
            ),
            working: false,
            queuedPrompts: [],
            modelActivity: undefined,
            compactingSince: undefined,
            compactionStrategy: undefined,
            compactionProvider: undefined,
            compactionModel: undefined,
        }, "resident_agent_stopped", update.detail);
    }
    if (update.type === "status") {
        return {
            ...state,
            ...(update.state === "idle"
                ? {
                    entries: settleTrailingThoughts(applyToolDetailPreference(
                        settleToolEntries(state.entries),
                        state.toolDetailsExpanded,
                    )),
                }
                : {}),
            working: update.state !== "idle",
            ...(update.state === "idle" ? { modelActivity: undefined } : {}),
        };
    }
    if (update.type === "task_notification") {
        // A peer message shows who wrote, and nothing else. The body and the
        // instructions that come with it are for the agent reading its inbox,
        // and dumping them here reads as noise the user cannot act on.
        return appendEntry(state, {
            kind: "notification",
            text: update.kind === "peer"
                ? `Message from ${update.sourceAgentId}`
                : update.kind === "attention"
                ? `Async subagent ${update.sourceAgentId} needs attention:\n${update.content}`
                : `Async subagent ${update.sourceAgentId}:\n${update.content}`,
        });
    }
    if (update.type === "notice" && update.key === "inbox") {
        return appendEntry({
            ...state,
            entries: state.entries.filter((entry) => entry.kind !== "inbox"),
        }, {
            kind: "inbox",
            text: `${update.count} unread inbox entr${
                update.count === 1 ? "y" : "ies"
            }`,
        });
    }
    if (update.type === "notice") {
        return state;
    }
    if (update.type === "history") {
        const canonicalEntries = applyToolDetailPreference(
            toTuiTranscriptEntries(update.entries),
            state.toolDetailsExpanded,
        );
        // The live reasoning row is rebuilt rather than preserved, so a rebuild
        // that lands mid-phase puts it back at the end where it belongs.
        return withLiveThinking({
            ...state,
            // A rebuild can restore a summary the canonical rows no longer
            // have a place for, which lands it behind the answer it belongs
            // in front of. Settling here is what the end of a turn does.
            entries: settleTrailingThoughts(foldAdjacentThoughts(
                hoistStrandedThoughts(
                    preserveLiveReviewEntries(state.entries, canonicalEntries),
                ),
            )),
            ...(update.context === undefined
                ? {}
                : { context: update.context }),
            ...(update.usage === undefined
                ? {}
                : { sessionUsage: update.usage }),
        });
    }
    if (update.type === "context") {
        return { ...state, context: update.measurement };
    }
    if (update.type === "user_prompt") {
        const nextState = { ...state, modelActivity: undefined };
        if (userEntryShows(state.entries.at(-1), update.content, update.attachments)) {
            return nextState;
        }
        return appendEntry(nextState, userEntry(update.content, update.attachments));
    }
    if (update.type === "ui_request") {
        return state;
    }
    if (update.type === "ui_request_closed") {
        return state;
    }
    if (update.type === "model_settings") {
        return finishAdmissionFromSnapshot({
            // A model or a requested level the evidence does not cover leaves
            // the status line with nothing to report.
            ...(appliesToSettings(state.effortSubstitution, update.settings)
                ? state
                : { ...state, effortSubstitution: undefined }),
            modelSettings: update.settings,
            ...(update.origin === undefined
                ? {}
                : { modelSettingsOrigin: update.origin }),
        }, update.settings);
    }
    if (update.type === "agent_worn") {
        const next = {
            ...state,
            agent: {
                name: update.name,
                ...(update.tools === undefined ? {} : { tools: update.tools }),
                ...(update.skills === undefined
                    ? {}
                    : { skills: update.skills }),
                ...(update.posture === undefined
                    ? {}
                    : { posture: update.posture }),
                ...(update.forbiddenAccess === undefined
                    ? {}
                    : { forbiddenAccess: update.forbiddenAccess }),
            },
        };
        // Switching is loud by design: the transcript says it happened, at the
        // moment it applied rather than when it was asked for.
        return appendTuiNotice(
            next,
            update.notice ?? `Switched to ${update.name}.`,
            "soft",
        );
    }
    if (update.type === "agent_catalog") {
        // The catalog answers a request the surface is already waiting on.
        return state;
    }
    if (update.type === "agent_rejected") {
        return appendTuiNotice(state, update.reason);
    }
    if (update.type === "session_model_settings_history") {
        return { ...state, modelSettingsHistory: update.entries };
    }
    if (update.type === "pool_admission_progress") {
        return applyAdmissionProgress(state, update);
    }
    if (update.type === "pool_admission_result") {
        return applyAdmissionResult(state, update);
    }
    if (update.type === "model_settings_rejected") {
        // The refusal is written where the request is known, which is the only
        // place that can name what was asked for. A line here could say no more
        // than that something was refused.
        return state;
    }
    if (update.type === "permissions") {
        return {
            ...state,
            approvalMode: update.mode,
            ...(update.inspection === undefined
                ? {}
                : { permissionInspection: update.inspection }),
            ...(update.origin === undefined
                ? {}
                : { approvalModeOrigin: update.origin }),
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
    // A consult belongs to the extension that asked for it, not to the
    // transcript: nothing here changes because another model answered.
    if (
        update.type === "consult_result"
        || update.type === "consult_rejected"
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
    if (update.type === "prompt_rejected") {
        // The optimistic user entry stays: it is what the person typed, and
        // the notice under it says it did not run. Clearing `working` is the
        // part that matters, since the refused prompt started no turn, and a
        // turn that is genuinely running re-asserts it on its next status.
        return appendTuiNotice({ ...state, working: false }, update.reason);
    }
    if (update.type === "compaction") {
        return applyCompaction(state, update);
    }
    if (update.type === "model_substitution") {
        // A spawn's substitution is the spawn's business: it reaches the
        // transcript and stops there, because the status line describes the
        // pair this session is dialed to, which a child never changes.
        if (update.source === "subagent") {
            return appendEntry(state, substitutionEntry(update));
        }
        if (update.scope !== "effort") {
            return appendEntry({
                ...state,
                modelFallback: {
                    from: update.model,
                    to: update.using ?? update.model,
                },
            }, substitutionEntry(update));
        }
        const substitution: TuiEffortSubstitution = {
            model: update.model,
            requested: update.requested,
            ...(update.using === undefined ? {} : { effective: update.using }),
        };
        const next = {
            ...state,
            effortSubstitution: substitution,
            turnSubstituted: true,
        };
        // The same substitution, turn after turn, is one fact rather than news
        // each time. The status line carries it for as long as it holds; the
        // transcript says it once, and again when it changes.
        return sameSubstitution(state.effortSubstitution, substitution)
            ? next
            : appendEntry(next, substitutionEntry(update));
    }
    return assertNever(update);
}

/**
 * A completed answer is the last row of its turn, even after a checkpoint.
 *
 * The stretch that lands behind it is also one stretch, not one row per phase:
 * a rebuild restores each phase as it was recorded, and the append path's
 * merge never sees them.
 */
function settleTrailingThoughts(
    entries: readonly TuiTranscriptEntry[],
): readonly TuiTranscriptEntry[] {
    let thoughtStart = entries.length;
    while (thoughtStart > 0 && entries[thoughtStart - 1]?.kind === "thought") {
        thoughtStart -= 1;
    }
    if (thoughtStart === entries.length
        || entries[thoughtStart - 1]?.kind !== "assistant") {
        return entries;
    }

    const next = [...entries];
    const thoughts = next.splice(thoughtStart) as TuiTextTranscriptEntry[];
    next.splice(thoughtStart - 1, 0, ...foldThoughts(thoughts));
    return next;
}

/**
 * A summary stranded at the tail of a shortened rebuild lands behind the
 * notice that ended its turn, but the thinking happened before the end: the
 * stretch moves back above the trailing notices, where folding can rejoin it
 * to the stretch it was split from.
 */
function hoistStrandedThoughts(
    entries: readonly TuiTranscriptEntry[],
): readonly TuiTranscriptEntry[] {
    let thoughtStart = entries.length;
    while (thoughtStart > 0 && entries[thoughtStart - 1]?.kind === "thought") {
        thoughtStart -= 1;
    }
    let insert = thoughtStart;
    while (insert > 0 && entries[insert - 1]?.kind === "notice") {
        insert -= 1;
    }
    if (thoughtStart === entries.length || insert === thoughtStart) {
        return entries;
    }
    const next = [...entries];
    const thoughts = next.splice(thoughtStart);
    next.splice(insert, 0, ...thoughts);
    return next;
}

/**
 * A rebuild can land summaries side by side: restoring drops the rows that
 * separated them, and a summary whose anchor count outruns a shortened
 * history is placed at the tail next to the ones after it. Adjacent summaries
 * are one stretch to the reader, so each run collapses to one row.
 */
function foldAdjacentThoughts(
    entries: readonly TuiTranscriptEntry[],
): readonly TuiTranscriptEntry[] {
    const next: TuiTranscriptEntry[] = [];
    for (const entry of entries) {
        const previous = next.at(-1);
        if (entry.kind === "thought" && previous?.kind === "thought") {
            next[next.length - 1] = mergeThoughts(previous, entry);
        } else {
            next.push(entry);
        }
    }
    return next;
}

/** One stretch of thinking is one row, however many phases reported it. */
function foldThoughts(
    thoughts: readonly TuiTextTranscriptEntry[],
): readonly TuiTextTranscriptEntry[] {
    const first = thoughts[0];
    if (first === undefined) {
        return thoughts;
    }
    return [thoughts.slice(1).reduce(mergeThoughts, first)];
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
        const started = {
            ...state,
            compactingSince: Date.now(),
            compactionStrategy: update.strategy,
            compactionProvider: update.provider,
            compactionModel: update.model,
        };
        return update.warning === undefined
            ? started
            : appendTuiNotice(started, update.warning);
    }
    if (update.outcome === "busy") {
        // A refused manual request. It had no started phase of its own, so it
        // must not clear the mark of a compaction that is still running.
        return appendTuiNotice(
            state,
            "Compaction runs between turns. Try again once this one finishes.",
        );
    }
    // Every other finish clears the start mark, whatever the outcome: the
    // status line must never keep filling after the work has stopped.
    state = {
        ...state,
        compactingSince: undefined,
        compactionStrategy: undefined,
        compactionProvider: undefined,
        compactionModel: undefined,
    };
    if (update.outcome === "compacted") {
        return appendTuiNotice(
            state,
            "Earlier messages were summarized. They are still shown here, but "
                + "the model now sees the summary instead.",
        );
    }
    if (update.outcome === "not_needed") {
        // Reached only when the model's context window is unknown, since a
        // manual request otherwise skips the trigger check.
        return appendTuiNotice(
            state,
            "Could not summarize: the model's context window is not known, "
                + "so there is no size to summarize down to. Set "
                + "compaction.target_tokens or compaction.trigger_tokens to "
                + "give it one.",
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
    if (update.outcome === "cancelled") {
        // Silence here reads as a compaction that is still running, or one
        // that quietly failed. It stopped because it was asked to.
        return appendTuiNotice(
            state,
            "Compaction stopped. The earlier messages were left as they were.",
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

/**
 * Opens the checklist the moment `pool_add` is sent, so the transcript answers
 * the keypress immediately rather than waiting on the first probe. Only the
 * sender knows which model the request names: the progress updates carry the
 * requestId alone.
 */
export function beginTuiAdmission(
    state: TuiState,
    requestId: string,
    subject: string,
): TuiState {
    const admission: TuiAdmissionState = { requestId, subject, steps: [] };
    return withAdmissionEntry({ ...state, admission }, admission);
}

function applyAdmissionProgress(
    state: TuiState,
    update: PoolAdmissionProgressUpdate,
): TuiState {
    const current = state.admission?.requestId === update.requestId
        ? state.admission
        // A stream this client did not start (say, after a reattach) still
        // renders: the checklist is exactly what the engine sends.
        : { requestId: update.requestId, subject: "model", steps: [] };
    const seen = current.steps.some((step) => step.step === update.step);
    const next: TuiAdmissionState = {
        ...current,
        steps: seen
            ? current.steps.map((step) =>
                step.step === update.step
                    ? {
                        step: update.step,
                        label: update.label,
                        status: update.status,
                        ...(update.detail === undefined
                            ? {}
                            : { detail: update.detail }),
                    }
                    : step
            )
            : [...current.steps, {
                step: update.step,
                label: update.label,
                status: update.status,
                ...(update.detail === undefined
                    ? {}
                    : { detail: update.detail }),
            }],
    };
    return withAdmissionEntry({ ...state, admission: next }, next);
}

function applyAdmissionResult(
    state: TuiState,
    update: PoolAdmissionResultUpdate,
): TuiState {
    const current = state.admission?.requestId === update.requestId
        ? state.admission
        : {
            requestId: update.requestId,
            subject: `${update.provider}/${update.model}`,
            steps: [],
        };
    const next: TuiAdmissionState = {
        ...current,
        verdict: update.verdict,
        provider: update.provider,
        model: update.model,
        ...(update.reason === undefined ? {} : { reason: update.reason }),
        ...(update.statusCode === undefined
            ? {}
            : { statusCode: update.statusCode }),
    };
    // "added" stays live until the refreshed pool snapshot supplies the
    // verified level count. The other verdicts are complete as they stand.
    const settled: TuiAdmissionState = update.verdict === "added"
        ? next
        : { ...next, settled: true };
    return withAdmissionEntry({ ...state, admission: settled }, settled);
}

/**
 * The `model_settings` snapshot that follows an "added" verdict carries the
 * one fact the verdict line still owes the user: how many reasoning levels
 * admission verified.
 */
function finishAdmissionFromSnapshot(
    state: TuiState,
    settings: ModelTurnSettings,
): TuiState {
    const admission = state.admission;
    if (admission?.verdict !== "added" || admission.settled === true) {
        return state;
    }
    const entry = settings.pooled?.find((candidate) =>
        candidate.provider === admission.provider
        && candidate.model === admission.model
    );
    const finished: TuiAdmissionState = {
        ...admission,
        ...(entry === undefined ? {} : { verifiedLevels: entry.levels.length }),
        settled: true,
    };
    return withAdmissionEntry({ ...state, admission: finished }, finished);
}

/** Symbols one column wide, so the step labels line up as a checklist. */
function admissionStepMark(status: TuiAdmissionStep["status"]): string {
    if (status === "running") return "…";
    if (status === "passed") return "✓";
    if (status === "failed") return "✗";
    return "−";
}

/** One line per step, in the order the engine ran them. */
export function tuiAdmissionStepLines(
    admission: TuiAdmissionState,
): readonly string[] {
    return admission.steps.map((step) => {
        const detail = step.detail === undefined ? "" : `: ${step.detail}`;
        const skipped = step.status === "skipped" ? " (skipped)" : "";
        return `  ${admissionStepMark(step.status)} ${step.label}${skipped}${detail}`;
    });
}

/**
 * The shortlist as prose, one line per entry: what it is, at what effort, whether a
 * probe has confirmed it, and where it runs.
 */
export function tuiPoolListing(
    pooled: readonly PooledModel[] | undefined,
): string {
    if (pooled === undefined || pooled.length === 0) {
        return "Your shortlist is empty. ^s in the model picker pins a model to it.";
    }
    const lines = pooled.map((entry) => {
        const effort = entry.defaultLevel ?? "provider default";
        const state = entry.verified ? "verified" : "unverified";
        const availability = entry.available ? "" : ", unavailable right now";
        // Name first where there is one, with the model id right behind it:
        // the name is what the user types, the id is what runs.
        const named = entry.poolName === undefined
            ? entry.model
            : `${entry.poolName} (${entry.model})`;
        return `  ${named} · ${effort} · ${state} · ${entry.provider}${availability}`;
    });
    return [`Shortlist (${pooled.length}):`, ...lines].join("\n");
}

/**
 * The verdict as one factual line, or undefined while the run is live. What
 * to do next (retry, dismiss) belongs to the surface showing it: the dialog
 * says it in its footer, the transcript appends its own sentence.
 */
export function tuiAdmissionVerdictLine(
    admission: TuiAdmissionState,
): string | undefined {
    if (admission.verdict === "added") {
        return admission.verifiedLevels === undefined
            ? "Pinned to your shortlist"
            : `Pinned to your shortlist (${admission.verifiedLevels} ${
                admission.verifiedLevels === 1 ? "level" : "levels"
            } verified)`;
    }
    if (admission.verdict === "incompatible") {
        return `Not pinned, incompatible${
            admission.reason === undefined ? "" : `: ${admission.reason}`
        }`;
    }
    if (admission.verdict === "pool_write_refused") {
        return `Not pinned, your shortlist was left untouched${
            admission.reason === undefined ? "" : `: ${admission.reason}`
        }`;
    }
    if (admission.verdict === "unavailable") {
        return `Provider unavailable${
            admission.statusCode === undefined
                ? ""
                : ` (HTTP ${admission.statusCode})`
        }${admission.reason === undefined ? "" : `: ${admission.reason}`}`;
    }
    return undefined;
}

function admissionChecklistParts(
    admission: TuiAdmissionState,
): { readonly text: string; readonly diagnostic?: TuiDiagnostic } {
    const text = [
        admission.verdict === undefined
            ? `Verifying ${admission.subject}…`
            : `Verifying ${admission.subject}`,
        ...tuiAdmissionStepLines(admission),
    ].join("\n");
    const verdict = tuiAdmissionVerdictLine(admission);
    if (verdict === undefined) {
        return { text };
    }
    if (admission.verdict === "added") {
        return { text: `${text}\n${verdict}` };
    }
    return {
        text,
        diagnostic: resolveTuiDiagnostic(
            "unknown",
            admission.verdict === "unavailable"
                ? `${verdict}. Select the model again to retry.`
                : verdict,
        ),
    };
}

/**
 * Take back the checklist for a request, entry and all. Used when a run is
 * about to be replaced by another one reporting on the same subject, so the
 * transcript carries one checklist rather than an abandoned one above it.
 */
export function dropTuiAdmission(
    state: TuiState,
    requestId: string,
): TuiState {
    return {
        ...state,
        entries: state.entries.filter((entry) =>
            !(entry.kind === "notice" && entry.admission === requestId)
        ),
        ...(state.admission?.requestId === requestId
            ? { admission: undefined }
            : {}),
    };
}

/**
 * The one checklist entry for this request, rewritten in place as its steps
 * change state. Matched by requestId rather than by position: a retry opens a
 * fresh entry, and anything else that lands in the transcript mid-run must not
 * absorb the update.
 */
function withAdmissionEntry(
    state: TuiState,
    admission: TuiAdmissionState,
): TuiState {
    const entry: TuiTranscriptEntry = {
        kind: "notice",
        ...admissionChecklistParts(admission),
        admission: admission.requestId,
    };
    const index = state.entries.findLastIndex((candidate) =>
        candidate.kind === "notice"
        && candidate.admission === admission.requestId
    );
    return index === -1
        ? appendEntry(state, entry)
        : {
            ...state,
            entries: state.entries.map((candidate, at) =>
                at === index ? entry : candidate
            ),
        };
}

function sameSubstitution(
    left: TuiEffortSubstitution | undefined,
    right: TuiEffortSubstitution,
): boolean {
    return left !== undefined
        && left.model === right.model
        && left.requested === right.requested
        && left.effective === right.effective;
}

/** Whether the recorded substitution still describes what a turn would do. */
function appliesToSettings(
    substitution: TuiEffortSubstitution | undefined,
    settings: ModelTurnSettings | undefined,
): boolean {
    return substitution !== undefined
        && settings?.model === substitution.model
        && (settings.reasoningEffort ?? "default") === substitution.requested;
}

/**
 * What a finished turn does to the substitution beside the requested level. A
 * turn that ran without substituting is the evidence that the level works
 * again, and it is said once, in the same place the substitution was.
 */
function clearedSubstitution(state: TuiState): TuiState {
    // The fallback lasted exactly one turn, which is what the committed pair
    // being retried next turn means. Clearing it here is the terminal event.
    state = state.modelFallback === undefined
        ? state
        : { ...state, modelFallback: undefined };
    const substitution = state.effortSubstitution;
    if (substitution === undefined) {
        return state;
    }
    if (state.turnSubstituted === true) {
        return { ...state, turnSubstituted: false };
    }
    const cleared = {
        ...state,
        effortSubstitution: undefined,
        turnSubstituted: false,
    };
    return appliesToSettings(substitution, state.modelSettings)
        ? appendTuiNotice(
            cleared,
            `Reasoning effort "${substitution.requested}" is available again`
                + ` on ${substitution.model}.`,
        )
        : cleared;
}

/** The row a substitution gets, live and on replay alike. */
function substitutionEntry(
    substitution: ModelSubstitution,
): TuiTranscriptEntry {
    return {
        kind: "substitution",
        text: formatModelSubstitution(substitution),
    };
}

export function appendTuiNotice(
    state: TuiState,
    message: string,
    tone?: "primary" | "soft" | "error",
    supersedes?: string,
): TuiState {
    const entry: TuiTranscriptEntry = {
        kind: "notice",
        text: message,
        liveOnly: true,
        ...(tone === undefined ? {} : { tone }),
        ...(supersedes === undefined ? {} : { supersedes }),
    };
    const previous = state.entries.at(-1);
    if (
        supersedes !== undefined && previous?.kind === "notice"
        && previous.supersedes === supersedes
    ) {
        return {
            ...state,
            entries: state.entries.map((existing, index) =>
                index === state.entries.length - 1 ? entry : existing
            ),
        };
    }
    return appendEntry(state, entry);
}

export function appendTuiDiagnostic(
    state: TuiState,
    code: TuiDiagnosticCode,
    message: string,
): TuiState {
    const previous = state.entries.at(-1);
    if (
        previous?.kind === "notice"
        && previous.text === ""
        && previous.diagnostic?.code === code
        && previous.diagnostic.message === message
    ) {
        return {
            ...state,
            entries: state.entries.map((entry, index) =>
                index === state.entries.length - 1
                    ? { ...previous, repeat: (previous.repeat ?? 1) + 1 }
                    : entry
            ),
        };
    }
    return appendEntry(state, {
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic(code, message),
    });
}

/** Transitional entry point while generic client failures receive codes. */
export function appendTuiError(state: TuiState, message: string): TuiState {
    return appendTuiDiagnostic(state, "unknown", message);
}

/**
 * A labeled block an extension wrote. It renders like a message but is not one:
 * the transcript is a view here, and nothing about the session changed.
 */
export function appendTuiExtensionBlock(
    state: TuiState,
    label: string,
    text: string,
): TuiState {
    return appendEntry(
        appendEntry(state, { kind: "extension_label", text: label }),
        { kind: "notification", text },
    );
}

/**
 * Settles the transcript for a host that went away. Being disconnected is a
 * state the status line holds until it is fixed, so nothing is written into
 * the transcript: a row would scroll away from the thing that is still true.
 */
export function failTuiConnection(state: TuiState): TuiState {
    return {
        ...state,
        entries: applyToolDetailPreference(
            settleToolEntries(state.entries),
            state.toolDetailsExpanded,
        ),
        working: false,
        queuedPrompts: [],
        compactingSince: undefined,
        compactionStrategy: undefined,
        compactionProvider: undefined,
        compactionModel: undefined,
    };
}

export function appendTuiThought(state: TuiState, seconds: number): TuiState {
    const reasoning = (state.pendingThinking ?? "").trim();
    const expanded = state.thinkingExpanded === true && reasoning.length > 0;
    const settled = dropTuiThinking(state);
    // A phase that reported no reasoning has nothing behind its row: the
    // elapsed time was already on the status line while it ran, and the row
    // that survives it cannot be opened.
    if (reasoning.length === 0) {
        return settled;
    }
    return insertBeforeTrailingAssistant(settled, {
        kind: "thought",
        text: thoughtSummary(seconds),
        seconds,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        ...(expanded ? { expanded: true } : {}),
    });
}

/** Every summary has reasoning behind it, so every summary is named for it. */
function thoughtSummary(seconds: number): string {
    return `Reasoning: ${seconds.toFixed(1)}s`;
}

/**
 * Drops reasoning that never reached a summary. A turn that ends without a
 * thought phase still has to clear it, or it leaks into the next one.
 */
export function dropTuiThinking(state: TuiState): TuiState {
    if (state.pendingThinking === undefined) {
        return state;
    }
    return {
        ...state,
        pendingThinking: undefined,
        entries: state.entries.filter((entry) => entry.kind !== "thinking"),
    };
}

/**
 * Opens or closes every reasoning fold at once.
 *
 * Transcript rows are not focusable, so there is nothing to point at to expand
 * one on its own. The flag also sets how later summaries arrive, so the choice
 * holds for the rest of the session rather than only for what is on screen.
 */
export function toggleTuiThinking(state: TuiState): TuiState {
    const expanded = state.thinkingExpanded !== true;
    return {
        ...state,
        thinkingExpanded: expanded,
        entries: state.entries.map((entry) => {
            if (entry.kind !== "thought" || entry.reasoning === undefined) {
                return entry;
            }
            return { ...entry, expanded };
        }),
    };
}

export function toggleTuiToolDetails(state: TuiState): TuiState {
    const expanded = !state.entries.some((entry) =>
        entry.kind === "tool"
        && entry.active !== true
        && entry.hidden !== true
    );
    return {
        ...state,
        toolDetailsExpanded: expanded,
        entries: applyToolDetailPreference(state.entries, expanded),
    };
}

export function renderTuiEntry(entry: TuiTranscriptEntry): StyledText {
    if (entry.kind === "diff") {
        return new StyledText([fg(TUI_MUTED)(entry.text)]);
    }
    if (entry.kind === "user") {
        // The band around a user message is chrome the renderer draws, so the
        // text itself carries no marker. What an extension prepended is not
        // drawn at all: it was sent, but it is not something the user said.
        const prefix = entry.dimmedPrefix ?? 0;
        return new StyledText([fg(TUI_TEXT)(
            prefix > 0 && prefix < entry.text.length
                ? entry.text.slice(prefix)
                : entry.text,
        )]);
    }
    if (entry.kind === "tool_header") {
        const header = renderToolHeader(entry);
        const inlinePreview = entry.inlineDetailPreview === true
            ? entry.detailPreview
            : undefined;
        return entry.detailLines === undefined
            ? new StyledText(header)
            : new StyledText([
                ...header,
                ...(inlinePreview === undefined
                    ? []
                    : renderInlineToolPreview(inlinePreview)),
                ...(entry.hint === true
                    ? [fg(TUI_MUTED)(`  ${tuiKeyHint("toggle_tool_details")}`)]
                    : []),
                ...(entry.detailPreview === undefined
                    || inlinePreview !== undefined
                    ? []
                    : renderCompactToolPreview(entry.detailPreview)),
            ]);
    }
    if (entry.kind === "tool") {
        return renderTuiToolRow(entry);
    }
    if (entry.kind === "substitution") {
        // Its own marker rather than a plain notice: a substitution says the
        // turn did not run on what was asked for, which outlives the run.
        return new StyledText([
            bold(fg(TUI_NOTICE)(`${SUBSTITUTION_MARKER} `)),
            fg(TUI_NOTICE)(entry.text),
        ]);
    }
    if (entry.kind === "inbox") {
        return new StyledText([
            bold(fg(TUI_ACCENT)("〰 Agent inbox 〰\n")),
            fg(TUI_MUTED)("  "),
            bold(fg(TUI_TEXT)(entry.text)),
        ]);
    }
    if (entry.kind === "extension_label") {
        // Styled rather than markdown: a label is a name, and a name with a
        // bracket or an asterisk in it must survive being displayed.
        return new StyledText([bold(fg(TUI_ACCENT)(entry.text))]);
    }
    if (entry.kind === "review") {
        return new StyledText(renderTuiReview(entry.text));
    }
    if (entry.kind === "notice") {
        if (entry.diagnostic === undefined && entry.admission !== undefined) {
            // The heading keeps a colour so a probe block can be found on the
            // way back up; the steps under it are Vera narrating itself and
            // sit back. One block, two weights, rather than a wall of one.
            const [heading, ...steps] = entry.text.split("\n");
            return new StyledText([
                fg(TUI_NOTICE)(heading ?? ""),
                ...(steps.length === 0
                    ? []
                    : [fg(TUI_MUTED)(`\n${steps.join("\n")}`)]),
            ]);
        }
        if (entry.diagnostic === undefined) {
            const color = entry.tone === "soft"
                ? TUI_MUTED
                : entry.tone === "error"
                ? TUI_DANGER
                : TUI_NOTICE;
            const text = fg(color)(entry.text);
            return new StyledText([
                entry.tone === "soft" ? italic(text) : text,
            ]);
        }
        const diagnostic = renderTuiDiagnostic(entry.diagnostic, entry.repeat);
        return new StyledText(entry.text === ""
            ? diagnostic
            : [
                fg(TUI_NOTICE)(`${entry.text}\n`),
                ...diagnostic,
            ]);
    }
    if (entry.kind === "thought") {
        // Latency is metadata about a turn, not the turn: it reads in the
        // muted role so the accent stays free for what the eye should find.
        const summary = fg(TUI_MUTED)(entry.text);
        if (entry.reasoning === undefined) {
            return new StyledText([summary]);
        }
        // The hint rides the rendered row, not the stored text, so a rebuilt
        // row carries the summary alone.
        const hint = fg(TUI_MUTED)(
            entry.expanded === true
                ? `  ${tuiKeyChord("toggle_thinking")} hide reasoning`
                : `  ${tuiKeyHint("toggle_thinking")}`,
        );
        return entry.expanded === true
            ? new StyledText([
                summary,
                hint,
                fg(TUI_MUTED)(`\n\n${plainReasoningSummary(entry.reasoning)}`),
            ])
            : new StyledText([summary, hint]);
    }
    if (entry.kind === "thinking") {
        return new StyledText([fg(TUI_MUTED)(liveThinkingTail(entry.text))]);
    }
    return new StyledText([fg(TUI_MUTED)(entry.text)]);
}

/**
 * How many rows the reasoning still arriving is allowed to occupy.
 *
 * Enough to see what the agent is chewing on, few enough that a model which
 * thinks at length cannot push the work above it off the screen.
 */
export const LIVE_THINKING_ROWS = 8;

/**
 * Both ends of the window reasoning arrives into.
 *
 * The window is marked at its ends rather than down its side: what the reader
 * needs is where the region starts and stops, and an ellipsis says the same
 * thing a scrollbar would, that there is more either way. The renderer centres
 * these, so they are drawn as rows of their own and not as part of the text.
 */
export const LIVE_THINKING_ELLIPSIS = "···";

/**
 * The last few lines of reasoning, as the tail of a fixed-height window.
 *
 * The row is bounded from the first delta rather than folded once the phase
 * ends, so nothing is ever drawn at full height and taken back. What scrolls
 * out of the window is not lost: the summary this row collapses into holds the
 * whole phase, which is where reasoning is meant to be read.
 *
 * The window is measured in source lines and the row is drawn unwrapped, so a
 * paragraph counts once however wide it is. Blank lines are dropped rather than
 * kept: a model that separates every sentence would spend half the window on
 * nothing, and the gaps read as a rendering fault rather than as the model's
 * own paragraphing.
 */
function liveThinkingTail(text: string): string {
    const lines = plainReasoningSummary(text)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
    return lines.slice(-LIVE_THINKING_ROWS).join("\n");
}

/** Provider summaries use Markdown headings; this row is a plain-text surface. */
function plainReasoningSummary(reasoning: string): string {
    return reasoning
        .replace(/\n[ \t]*[-=]{3,}[ \t]*(?=\n|$)/g, "")
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]+#*[ \t]*$/gm, "$1")
        .replace(/^[ \t]*(?:\*\*|__)(.*?)(?:\*\*|__)[ \t]*$/gm, "$1");
}

interface TuiReviewHighlightMatch {
    readonly index: number;
    readonly text: string;
}

/** Routine approval is quiet; only its decision stands out. */
function renderTuiReview(text: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const approvalPrefix = "Auto review ";
    if (!text.startsWith(approvalPrefix)) {
        return text.length === 0 ? [] : [fg(TUI_MUTED)(text)];
    }
    chunks.push(fg(TUI_MUTED)(approvalPrefix));

    let remaining = text.slice(approvalPrefix.length);
    const approved = "approved";
    if (!remaining.startsWith(approved)) {
        chunks.push(fg(TUI_MUTED)(remaining));
        return chunks;
    }
    chunks.push(fg(TUI_SUCCESS)(approved));
    remaining = remaining.slice(approved.length);

    const riskMarker = " (risk: ";
    const authorizationMarker = ", authorization: ";
    const authorizationTextPrefix = ", ";
    const headerEnd = "): ";
    const riskIndex = remaining.indexOf(riskMarker);
    const authorizationIndex = remaining.indexOf(
        authorizationMarker,
        riskIndex + riskMarker.length,
    );
    const headerEndIndex = remaining.indexOf(
        headerEnd,
        authorizationIndex + authorizationMarker.length,
    );
    if (riskIndex === -1 || authorizationIndex === -1 || headerEndIndex === -1) {
        chunks.push(fg(TUI_MUTED)(remaining));
        return chunks;
    }

    const authorizationTextStart = authorizationIndex
        + authorizationTextPrefix.length;
    chunks.push(fg(TUI_MUTED)(remaining.slice(0, authorizationTextStart)));
    const authorizationText = remaining.slice(
        authorizationTextStart,
        headerEndIndex,
    );
    chunks.push(fg(TUI_MUTED)(authorizationText));
    const reasonStart = headerEndIndex + headerEnd.length;
    chunks.push(fg(TUI_MUTED)(remaining.slice(headerEndIndex, reasonStart)));
    appendTuiReviewReason(chunks, remaining.slice(reasonStart));
    return chunks;
}

function appendTuiReviewReason(chunks: TextChunk[], reason: string): void {
    let remaining = reason;
    while (remaining.length > 0) {
        const match = findTuiReviewAllowDecision(remaining);
        if (match === undefined) {
            chunks.push(fg(TUI_MUTED)(remaining));
            return;
        }
        if (match.index > 0) {
            chunks.push(fg(TUI_MUTED)(remaining.slice(0, match.index)));
        }
        chunks.push(fg(TUI_SUCCESS)(match.text));
        remaining = remaining.slice(match.index + match.text.length);
    }
}

function findTuiReviewAllowDecision(
    text: string,
): TuiReviewHighlightMatch | undefined {
    const phrase = "an allow decision";
    const phraseIndex = text.indexOf(phrase);
    if (phraseIndex === -1) {
        return undefined;
    }
    return {
        index: phraseIndex + "an ".length,
        text: "allow",
    };
}

function renderTuiDiagnostic(
    diagnostic: TuiDiagnostic,
    repeat = 1,
): TextChunk[] {
    const message = repeat > 1
        ? `${diagnostic.message} (×${repeat})`
        : diagnostic.message;
    if (diagnostic.severity === "notice") {
        return [fg(TUI_MUTED)(message)];
    }
    if (diagnostic.severity === "fatal") {
        return [
            fg(TUI_DANGER)(`× ${diagnostic.state}  `),
            fg(TUI_TEXT)(message),
        ];
    }
    return [
        fg(TUI_DANGER)("× "),
        fg(TUI_TEXT)(message),
    ];
}

function renderToolHeader(entry: TuiTextTranscriptEntry): TextChunk[] {
    const folded = /^([+-]) (.+)$/.exec(entry.text);
    if (folded === null) {
        // A header with no fold marker still reserves the marker slot, so a
        // running group and the finished group it becomes share one column.
        return [fg(TUI_MUTED)("  "), bold(fg(TUI_TEXT)(entry.text))];
    }
    const [, marker, action] = folded;
    // The call reads on the header row, so a folded group is one sentence:
    // what was done, and to what.
    return [
        // A collapsed group keeps the fold-marker slot for alignment without
        // adding another dot to an already indented activity row.
        fg(TUI_MUTED)(marker === "+" ? "  " : "▾ "),
        bold(fg(TUI_TEXT)(action ?? "")),
        ...(entry.command === undefined
            ? []
            : [fg(TUI_MUTED)(`  ${entry.command}`)]),
    ];
}

function renderCompactToolPreview(preview: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    let tone: "call" | "result" = "result";
    for (const line of preview.split("\n")) {
        chunks.push(fg(TUI_MUTED)("\n"));
        if (line.startsWith("  │ ")) {
            tone = "call";
            chunks.push(fg(TUI_MUTED)("  │ "));
            chunks.push(fg(TUI_TEXT)(line.slice(4)));
            continue;
        }
        if (line.startsWith("  └ ")) {
            tone = "result";
            chunks.push(fg(TUI_MUTED)("  └ "));
            chunks.push(fg(TUI_MUTED)(line.slice(4)));
            continue;
        }
        chunks.push(fg(tone === "call" ? TUI_TEXT : TUI_MUTED)(line));
    }
    return chunks;
}

function renderInlineToolPreview(preview: string): TextChunk[] {
    const text = preview.startsWith("  └ ") ? preview.slice(4) : preview;
    return [fg(TUI_MUTED)(`  └ ${text}`)];
}

/** A row's text, carrying the count when the same call repeated. */
export function tuiToolRowText(entry: TuiTextTranscriptEntry): string {
    const repeat = entry.repeat ?? 1;
    return repeat > 1 ? `${entry.text} ×${repeat}` : entry.text;
}

/**
 * Tool rows keep their target quiet while giving the operation a semantic
 * accent. Result rows stay entirely muted: their text is output, not another
 * action label.
 */
function renderTuiToolRowChunks(
    entry: TuiTextTranscriptEntry,
): TextChunk[] {
    const text = tuiToolRowText(entry);
    if (entry.result === true) {
        return [fg(TUI_MUTED)(text)];
    }

    const action = /^(Read|List|Search|Edit|Write)(?=\s|$)/.exec(text);
    if (action === null) {
        return [fg(TUI_MUTED)(text)];
    }
    const label = action[1] ?? "";
    return [
        fg(TUI_ACCENT)(label),
        fg(TUI_MUTED)(text.slice(label.length)),
    ];
}

/** Renders a transcript row, including its inline gutter prefix. */
export function renderTuiToolRow(
    entry: TuiTextTranscriptEntry,
): StyledText {
    return new StyledText([
        fg(TUI_MUTED)(entry.prefix ?? ""),
        ...renderTuiToolRowChunks(entry),
    ]);
}

/** Renders the content column used by the dedicated tool-row component. */
export function renderTuiToolRowContent(
    entry: TuiTextTranscriptEntry,
): StyledText {
    return new StyledText(renderTuiToolRowChunks(entry));
}

export interface TuiEntrySpacing {
    readonly message: number;
    readonly toolGroup: number;
}

export const DEFAULT_TUI_ENTRY_SPACING: TuiEntrySpacing = {
    message: 1,
    toolGroup: 0,
};

export function tuiEntryMarginTop(
    entries: readonly TuiTranscriptEntry[],
    index: number,
    spacing: TuiEntrySpacing = DEFAULT_TUI_ENTRY_SPACING,
): number {
    if (index === 0) {
        return 0;
    }

    const current = entries[index];
    const previous = entries[index - 1];
    if (current?.kind !== "diff" && current?.diagnostic !== undefined) {
        if (current.diagnostic.severity === "fatal") {
            return Math.max(1, spacing.message);
        }
        if (previous?.kind !== "diff" && previous?.diagnostic !== undefined) {
            return 0;
        }
    }
    // Notices of one weight arriving back to back are one run of the same
    // thought, so they sit flush rather than as a stack of spaced blocks.
    if (
        current?.kind === "notice" && previous?.kind === "notice"
        && current.diagnostic === undefined && previous.diagnostic === undefined
        && current.admission === undefined && previous.admission === undefined
        && current.tone === previous.tone
    ) {
        return 0;
    }
    // Rows inside a group sit flush under their header. A new header also
    // continues directly from the activity row that preceded it, so changing
    // tool verbs does not break one run into a stack of spaced blocks. A diff
    // is a rendered block, so the next header falls through to message spacing.
    if (current?.kind === "tool") {
        return previous?.kind === "thought" && previous.expanded === true
            ? Math.max(1, spacing.message)
            : 0;
    }
    if (
        current?.kind === "tool_header"
        && (
            previous?.kind === "thought"
            || previous?.kind === "thinking"
            || previous?.kind === "tool"
            || previous?.kind === "tool_header"
            || previous?.kind === "review"
        )
    ) {
        if (previous?.kind === "thought" && previous.expanded === true) {
            return Math.max(1, spacing.message);
        }
        return spacing.toolGroup;
    }
    return spacing.message;
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

const LIVE_TOOL_HEADERS: Readonly<Record<string, string>> = {
    read: "Exploring",
    grep: "Exploring",
    list: "Exploring",
    bash: "Running",
    edit: "Editing",
    write: "Editing",
    subagent: "Delegating",
    async_subagent: "Delegating",
    ask_user: "Asking",
};

function bounded(value: string): string {
    return value.length > TOOL_SUMMARY_LIMIT
        ? `${value.slice(0, TOOL_SUMMARY_LIMIT - 1)}…`
        : value;
}

function toolHeader(tool: string, active: boolean): string {
    return active
        ? LIVE_TOOL_HEADERS[tool] ?? "Working"
        : TOOL_HEADERS[tool] ?? "Worked";
}

/**
 * Live and completed labels are two states of one activity group. Comparing
 * the rendered words directly would split a sweep whenever its first call
 * finished before the next call started.
 */
const TOOL_HEADER_GROUPS: Readonly<Record<string, string>> = {
    Exploring: "Explored",
    Explored: "Explored",
    Running: "Ran",
    Ran: "Ran",
    Editing: "Edited",
    Edited: "Edited",
    Delegating: "Delegated",
    Delegated: "Delegated",
    Asking: "Asked",
    Asked: "Asked",
    Working: "Worked",
    Worked: "Worked",
};

function toolHeaderGroup(header: string): string {
    return TOOL_HEADER_GROUPS[header] ?? header;
}

function stringArg(
    args: Readonly<Record<string, unknown>>,
    name: string,
): string | undefined {
    const value = args[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

let tuiWorkspaceRoots: readonly string[] = [process.cwd()];

/**
 * The session's workspace, not this process's cwd: the TUI can attach to a
 * session rooted anywhere. Tool results carry realpathed paths, so the
 * resolved form of the root is stripped too when it differs.
 */
export function setTuiWorkspaceRoot(workspace: string): void {
    const roots = [workspace];
    try {
        const resolved = realpathSync(workspace);
        if (resolved !== workspace) {
            roots.push(resolved);
        }
    } catch {
        // A root that does not resolve locally still strips as given.
    }
    tuiWorkspaceRoots = roots;
}

/** The workspace-relative path, since the absolute prefix is the same on every row. */
export function tuiDisplayPath(path: string): string {
    for (const root of tuiWorkspaceRoots) {
        const prefix = root.endsWith("/") ? root : `${root}/`;
        if (path.startsWith(prefix)) {
            return path.slice(prefix.length);
        }
    }
    return path;
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
        return `Read ${tuiDisplayPath(path)}`;
    }
    if (tool === "list" && path !== undefined) {
        return `List ${tuiDisplayPath(path)}`;
    }
    if (tool === "grep") {
        const pattern = stringArg(args, "pattern");
        if (pattern !== undefined) {
            return path === undefined
                ? `Search ${pattern}`
                : `Search ${pattern} in ${tuiDisplayPath(path)}`;
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
        return `${tool === "edit" ? "Edit" : "Write"} ${tuiDisplayPath(path)}`;
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
    active: boolean,
): TuiTranscriptEntry[] {
    // Review, thinking, and thought rows come and go: a history checkpoint
    // drops them, and a run has to group the same way either way, or the
    // checkpoint stops matching what is on screen.
    const previousIndex = entries.findLastIndex((entry) =>
        entry.kind !== "review" && entry.kind !== "thought"
        && entry.kind !== "thinking"
    );
    const previous = entries[previousIndex];
    const header = toolHeader(tool, active);
    const row = toolRowText(tool, args);
    if (
        !active
        && previous?.kind === "tool"
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
        && previous.header !== undefined
        && toolHeaderGroup(previous.header) === toolHeaderGroup(header);
    if (open) {
        const joined = [...entries, {
            kind: "tool",
            header,
            ...(active ? { tool, active: true } : {}),
            prefix: previous?.kind === "tool_header" ? "  └ " : "    ",
            text: row,
        } satisfies TuiTranscriptEntry];
        if (!active) {
            return joined;
        }

        // A settled group is working again. Keep its header in the live tense
        // until the last active call settles, without opening a second group.
        let headerIndex = entries.length - 1;
        while (
            headerIndex >= 0
            && entries[headerIndex]?.kind !== "tool_header"
        ) {
            headerIndex -= 1;
        }
        const groupHeader = entries[headerIndex];
        if (groupHeader?.kind !== "tool_header") {
            return joined;
        }
        joined[headerIndex] = {
            ...groupHeader,
            header,
            text: header,
            active: true,
        };
        return joined;
    }
    return [
        ...entries,
        {
            kind: "tool_header",
            header,
            ...(active ? { active: true } : {}),
            text: header,
        },
        {
            kind: "tool",
            header,
            ...(active ? { tool, active: true } : {}),
            prefix: "  └ ",
            text: row,
        },
    ];
}

/**
 * Settles the oldest matching live call. Calls can finish out of order, so the
 * row itself carries the tool name instead of assuming the last row finished.
 */
function finishToolEntry(
    entries: readonly TuiTranscriptEntry[],
    tool: string,
    output?: string,
): TuiTranscriptEntry[] {
    const toolIndex = entries.findIndex((entry) =>
        entry.kind === "tool" && entry.active === true && entry.tool === tool
    );
    if (toolIndex === -1) {
        return [...entries];
    }

    let headerIndex = toolIndex - 1;
    while (headerIndex >= 0 && entries[headerIndex]?.kind !== "tool_header") {
        headerIndex -= 1;
    }
    if (headerIndex < 0) {
        return entries.map((entry, index) =>
            index === toolIndex ? { ...entry, active: false } : entry
        );
    }

    let groupEnd = headerIndex + 1;
    while (
        groupEnd < entries.length
        && entries[groupEnd]?.kind !== "tool_header"
        && (
            entries[groupEnd]?.kind === "tool"
            || entries[groupEnd]?.kind === "review"
            || entries[groupEnd]?.kind === "thought"
            || entries[groupEnd]?.kind === "thinking"
        )
    ) {
        groupEnd += 1;
    }
    const hasAnotherActiveCall = entries
        .slice(headerIndex + 1, groupEnd)
        .some((entry, offset) =>
            headerIndex + 1 + offset !== toolIndex
            && entry.kind === "tool"
            && entry.active === true
        );
    const completedHeader = toolHeader(tool, false);

    const completed = entries.map((entry, index) => {
        if (index === toolIndex && entry.kind === "tool") {
            const { active: _active, tool: _tool, ...completed } = entry;
            return {
                ...completed,
                ...(output === undefined ? {} : { prefix: "  │ " }),
                ...(hasAnotherActiveCall ? {} : { header: completedHeader }),
            };
        }
        if (hasAnotherActiveCall || index < headerIndex || index >= groupEnd) {
            return entry;
        }
        if (entry.kind === "tool_header") {
            const { active: _active, ...completed } = entry;
            return {
                ...completed,
                header: completedHeader,
                text: completedHeader,
            };
        }
        return entry.kind === "tool"
            ? { ...entry, header: completedHeader }
            : entry;
    });
    if (output === undefined) {
        return completed;
    }
    const groupHeader = entries[headerIndex];
    completed.splice(groupEnd, 0, {
        kind: "tool",
        header: hasAnotherActiveCall
            ? (groupHeader?.kind === "tool_header"
                ? groupHeader.header
                : completedHeader)
            : completedHeader,
        result: true,
        prefix: "  └ ",
        text: toolResultText(output, tool),
    });
    return completed;
}

function toolResultText(output: string, tool?: string): string {
    const text = output.trim();
    if (tool === "ask_user") {
        return formatAskUserResult(text);
    }
    return text.length === 0 ? "(no output)" : bounded(text);
}

/** One semantic formatter shared by live rows and history replay. */
export function formatAskUserResult(output: string): string {
    if (output.length === 0) return "Question completed";
    try {
        const value = JSON.parse(output) as Record<string, unknown>;
        if (value.cancelled === true) return "Question dismissed";
        if (value.custom === true && typeof value.text === "string") {
            return `Answered: ${bounded(value.text)}`;
        }
        if (
            typeof value.choice_id === "string"
            && typeof value.label === "string"
        ) {
            const notes = typeof value.notes === "string"
                && value.notes.trim().length > 0
                ? ` (notes: ${bounded(value.notes.trim())})`
                : "";
            return `Answered: ${bounded(value.label)}${notes}`;
        }
    } catch {
        // A provider/tool error is still useful as its original text.
    }
    return bounded(output);
}

const COMPACT_TOOL_LINE_CHARS = 96;
const INLINE_TOOL_PREVIEW_CHARS = 24;

/**
 * Completed tool groups with a result share one compact shape. An explicit
 * detail choice applies to every completed group; active work always remains
 * visible so the user can see what is happening.
 */
function applyToolDetailPreference(
    entries: readonly TuiTranscriptEntry[],
    preference?: boolean,
): TuiTranscriptEntry[] {
    const next = [...entries];
    // The detail toggle is taught once per transcript, not on every group.
    let hintUsed = false;
    for (let headerIndex = 0; headerIndex < next.length; headerIndex += 1) {
        const header = next[headerIndex];
        if (header?.kind !== "tool_header") {
            continue;
        }

        let end = headerIndex + 1;
        while (
            end < next.length
            && (
                next[end]?.kind === "tool"
                || next[end]?.kind === "review"
                || next[end]?.kind === "thought"
                || next[end]?.kind === "thinking"
            )
        ) {
            end += 1;
        }
        const rows = next.slice(headerIndex + 1, end).filter(
            (entry): entry is TuiTextTranscriptEntry => entry.kind === "tool",
        );
        const active = header.active === true || rows.some((entry) =>
            entry.kind === "tool" && entry.active === true
        );
        const hasResult = rows.some((entry) => entry.result === true);
        const detailLines = rows.reduce((total, entry) =>
            total + entry.text.split("\n").length, 0
        );
        const foldable = !active
            && detailLines > 0
            && (hasResult || preference !== undefined);
        const expanded = preference === true;
        const calls = toolCallLines(rows);
        const summary = compactToolSummary(rows, calls);
        const base = header.header ?? header.text.replace(/^[+-] /, "");
        const {
            detailLines: _detailLines,
            detailPreview: _detailPreview,
            inlineDetailPreview: _inlineDetailPreview,
            command: _command,
            hint: _hint,
            expanded: _expanded,
            ...plainHeader
        } = header;
        const hinted = foldable && !hintUsed;
        if (hinted) hintUsed = true;

        next[headerIndex] = foldable
            ? {
                ...plainHeader,
                text: `${expanded ? "-" : "+"} ${base}`,
                detailLines,
                ...(!expanded && calls.length === 1 && calls[0] !== undefined
                    ? { command: compactToolLine(calls[0]) }
                    : {}),
                ...(expanded || summary === undefined
                    ? {}
                    : {
                        detailPreview: summary,
                        ...(inlineToolPreview(summary, rows, calls)
                            ? { inlineDetailPreview: true }
                            : {}),
                    }),
                ...(hinted ? { hint: true } : {}),
                expanded,
            }
            : {
                ...plainHeader,
                text: base,
            };
        for (let index = headerIndex + 1; index < end; index += 1) {
            const entry = next[index];
            if (entry?.kind === "tool") {
                const { hidden: _hidden, ...visible } = entry;
                next[index] = foldable && !expanded
                    ? { ...visible, hidden: true }
                    : visible;
            }
        }
        headerIndex = end - 1;
    }
    return next;
}

/** The call lines in a group, which is what a folded group is about. */
function toolCallLines(
    rows: readonly TuiTextTranscriptEntry[],
): readonly string[] {
    return rows
        .filter((row) => row.prefix === "  │ ")
        // A folded group has one line to say what ran. Keeping only the first
        // physical line turns a heredoc or a `-e` script into its opener, so
        // the whole call is flattened and then cut to the line budget.
        .map((row) => tuiToolRowText(row).replace(/\s+/g, " ").trim())
        .filter((line) => line.length > 0);
}

/**
 * The single line a folded group keeps. Several calls summarize to what they
 * touched; one call summarizes to the head of what it produced. Neither says
 * how much was left out: the toggle is what shows the rest.
 */
function compactToolSummary(
    rows: readonly TuiTextTranscriptEntry[],
    calls: readonly string[],
): string | undefined {
    if (calls.length > 1) {
        return `  └ ${compactToolLine(compactFoldedCalls(calls).join(", "))}`;
    }
    const result = rows.find((row) => row.prefix === "  └ ");
    const line = (result === undefined ? undefined : tuiToolRowText(result))
        ?.split("\n")
        .find((entry) => entry.trim().length > 0);
    return line === undefined ? undefined : `  └ ${compactToolLine(line)}`;
}

/**
 * A folded multi-call row is only a clue; full paths remain in its details.
 * Keeping the shortest unique suffix avoids a second renderer truncation
 * without making equal filenames from different directories look identical.
 */
interface CompactPathCall {
    readonly action: string;
    readonly path: string;
    readonly segments: readonly string[];
}

function compactFoldedCalls(calls: readonly string[]): string[] {
    const parsed = calls.map((call): CompactPathCall | undefined => {
        const match = /^(Read|List|Edit|Write) (.+)$/.exec(call);
        if (match?.[1] === undefined || match[2] === undefined) return undefined;
        const segments = match[2].split(/[\\/]+/).filter((part) => part.length > 0);
        return { action: match[1], path: match[2], segments };
    });
    return calls.map((call, index) => {
        const current = parsed[index];
        if (current === undefined || current.segments.length === 0) return call;
        for (let kept = 1; kept <= current.segments.length; kept += 1) {
            const suffix = current.segments.slice(-kept).join("/");
            const collides = parsed.some((other, otherIndex) =>
                otherIndex !== index
                && other?.action === current.action
                && other.path !== current.path
                && other.segments.slice(-kept).join("/") === suffix
            );
            if (!collides) return `${current.action} ${suffix}`;
        }
        return `${current.action} ${current.path}`;
    });
}

function compactToolLine(line: string): string {
    const characters = Array.from(line);
    return characters.length > COMPACT_TOOL_LINE_CHARS
        ? `${characters.slice(0, COMPACT_TOOL_LINE_CHARS - 1).join("")}…`
        : line;
}

function inlineToolPreview(
    preview: string,
    rows: readonly TuiTextTranscriptEntry[],
    calls: readonly string[],
): boolean {
    const match = /^  └ ([^\n]+)$/.exec(preview);
    if (
        match?.[1] === undefined
        || Array.from(match[1]).length > INLINE_TOOL_PREVIEW_CHARS
    ) {
        return false;
    }
    if (calls.length > 1) {
        return true;
    }
    const result = rows.find((row) => row.prefix === "  └ ");
    return result !== undefined && !tuiToolRowText(result).includes("\n");
}

function settleToolEntries(
    entries: readonly TuiTranscriptEntry[],
): readonly TuiTranscriptEntry[] {
    let settled = entries;
    while (true) {
        const active = settled.find((entry) =>
            entry.kind === "tool" && entry.active === true
        );
        if (active?.kind !== "tool" || active.tool === undefined) {
            return settled;
        }
        settled = finishToolEntry(settled, active.tool);
    }
}

function toTuiTranscriptEntries(
    entries: readonly TranscriptEntry[],
): TuiTranscriptEntry[] {
    let converted: TuiTranscriptEntry[] = [];
    for (const entry of entries) {
        converted = entry.kind === "tool"
            ? withToolEntry(converted, entry.tool, entry.args, false)
            : entry.kind === "tool_result"
            ? withHistoricalToolResult(converted, entry.tool, entry.output)
            : [...converted, withStoreEntryId(
                toSingleTuiTranscriptEntry(entry),
                entry,
            )];
    }
    return converted;
}

/**
 * Keep the store's id on the row it became, when the entry had one.
 *
 * Carried so a client can find a row again by the same reference resume and
 * rewind take. Only messages have one: a tool row, a notice and a diff are
 * things the transcript draws, not entries the store holds.
 */
function withStoreEntryId(
    converted: TuiTranscriptEntry,
    entry: TranscriptEntry,
): TuiTranscriptEntry {
    const id = "id" in entry ? entry.id : undefined;
    return id === undefined || converted.kind === "diff"
        ? converted
        : { ...converted, entryId: id };
}

function toSingleTuiTranscriptEntry(
    entry: Exclude<TranscriptEntry, { kind: "tool" | "tool_result" }>,
): TuiTranscriptEntry {
    if (entry.kind === "error") {
        return {
            kind: "notice",
            text: "",
            diagnostic: entry.outcome === "aborted"
                ? resolveTuiDiagnostic(
                    "turn_interrupted",
                    INTERRUPTED_TURN_TEXT,
                )
                : resolveTuiDiagnostic(
                    "model_request_failed",
                    `Model error: ${entry.detail ?? "Model request failed"}`,
                ),
        };
    }
    if (entry.kind === "presentation") {
        return presentationEntry(entry.presentation);
    }
    if (entry.kind === "model_substitution") {
        return substitutionEntry(entry.substitution);
    }
    if (entry.kind === "empty") {
        return emptyTurnEntry();
    }
    if (entry.kind === "harness") {
        return { kind: "notice", text: entry.text, tone: entry.tone };
    }
    return entry.kind === "user"
        ? userEntry(entry.text, entry.attachments)
        : entry;
}

function withHistoricalToolResult(
    entries: readonly TuiTranscriptEntry[],
    tool: string,
    output: string,
): TuiTranscriptEntry[] {
    const callIndex = entries.findIndex((entry) =>
        entry.kind === "tool"
        && entry.result !== true
        && entry.hasResult !== true
    );
    if (callIndex === -1) {
        return [...entries];
    }
    const call = entries[callIndex]!;
    const next = entries.map((entry, index) =>
        index === callIndex && entry.kind === "tool"
            ? { ...entry, hasResult: true, prefix: "  │ " }
            : entry
    );
    next.splice(callIndex + 1, 0, {
        kind: "tool",
        header: call.kind === "tool" ? call.header : toolHeader(tool, false),
        result: true,
        prefix: "  └ ",
        text: toolResultText(output, tool),
    });
    return next;
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
            text: tuiDisplayPath(presentation.path),
            path: presentation.path,
            patch: presentation.patch,
        }
        : { kind: "notice", text: presentation.text };
}

function userEntry(
    text: string,
    attachments?: readonly AttachmentRef[],
    dimmedPrefix?: number,
): TuiTextTranscriptEntry {
    const labels = (attachments ?? []).map(attachmentLabel);
    return {
        kind: "user",
        text,
        ...(labels.length === 0 ? {} : { attachments: labels }),
        ...(dimmedPrefix === undefined || dimmedPrefix <= 0
            ? {}
            : { dimmedPrefix }),
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

function appendThinkingText(state: TuiState, text: string): TuiState {
    return withLiveThinking({
        ...state,
        pendingThinking: (state.pendingThinking ?? "") + text,
    });
}

/**
 * Puts the reasoning collected so far on screen as one live row at the end of
 * the transcript.
 *
 * `pendingThinking` stays the record of what arrived, and the row is rebuilt
 * from it rather than appended to, so a history rebuild that drops the row
 * costs nothing: the next delta puts it back whole. That is also why the row
 * carries no state of its own.
 */
function withLiveThinking(state: TuiState): TuiState {
    const settled = state.entries.filter((entry) => entry.kind !== "thinking");
    const pending = state.pendingThinking;
    const withoutLiveThinking = { ...state, entries: settled };
    return pending === undefined || pending.length === 0
        ? withoutLiveThinking
        : insertBeforeTrailingAssistant(withoutLiveThinking, {
            kind: "thinking",
            text: pending,
        });
}

/** Provider streams may deliver reasoning after the answer it precedes. */
function insertBeforeTrailingAssistant(
    state: TuiState,
    entry: TuiTranscriptEntry,
): TuiState {
    const entries = [...state.entries];
    const last = entries.at(-1);
    const index = last?.kind === "assistant" ? entries.length - 1 : entries.length;
    if (entry.kind === "thought") {
        const previous = lastThought(entries, index);
        if (previous !== undefined) {
            entries[previous.index] = mergeThoughts(previous.entry, entry);
            return { ...state, entries };
        }
    }
    entries.splice(index, 0, entry);
    return { ...state, entries };
}

/**
 * Where a new summary joins the one before it, if anything.
 *
 * Tool calls do not separate two stretches of thinking: the summary belongs to
 * the work it precedes, so a turn that thinks, calls, and thinks again reports
 * one stretch above the calls. A line of the answer does separate them, which
 * is what gives each thing the agent says its own summary.
 */
function lastThought(
    entries: readonly TuiTranscriptEntry[],
    before: number,
): { readonly index: number; readonly entry: TuiTextTranscriptEntry } | undefined {
    for (let index = before - 1; index >= 0; index -= 1) {
        const found = entries[index];
        if (found?.kind === "thought") return { index, entry: found };
        if (found?.kind !== "tool" && found?.kind !== "tool_header") {
            return undefined;
        }
    }
    return undefined;
}

/**
 * One phase of thinking is not one row. A turn that thinks, thinks again, and
 * thinks once more between two tool calls reports the whole stretch, because
 * the split between phases is the provider's and says nothing to the reader.
 */
function mergeThoughts(
    first: TuiTextTranscriptEntry,
    second: TuiTextTranscriptEntry,
): TuiTextTranscriptEntry {
    const seconds = (first.seconds ?? 0) + (second.seconds ?? 0);
    const reasoning = [first.reasoning, second.reasoning]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n\n");
    const expanded = first.expanded === true || second.expanded === true;
    return {
        ...first,
        text: thoughtSummary(seconds),
        seconds,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        ...(expanded && reasoning.length > 0 ? { expanded: true } : {}),
    };
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
        && entry.kind !== "thinking"
    );
    const base = current.some((entry) => entry.kind === "review")
            && transcriptEntriesEqual(withoutTransientEntries, canonical)
        ? current.filter((entry) =>
            entry.kind !== "thought" && entry.kind !== "thinking"
            && (entry.kind === "diff" || entry.liveOnly !== true)
        )
        : canonical;
    return restoreReasoningEntries(
        restoreDimmedPrefixes(base, current),
        anchoredReasoningEntries(current),
    );
}

/**
 * A history rebuild carries the message the agent was sent, which is the
 * replaced text; how much of it an extension injected is only known here. The
 * live entry keeps that measure, so a rebuilt row takes it back by text.
 */
function restoreDimmedPrefixes(
    rebuilt: readonly TuiTranscriptEntry[],
    live: readonly TuiTranscriptEntry[],
): readonly TuiTranscriptEntry[] {
    const dimmed = new Map<string, number>();
    for (const entry of live) {
        if (entry.kind === "user" && entry.dimmedPrefix !== undefined) {
            dimmed.set(entry.text, entry.dimmedPrefix);
        }
    }
    if (dimmed.size === 0) return rebuilt;
    return rebuilt.map((entry) => {
        if (entry.kind !== "user" || entry.dimmedPrefix !== undefined) {
            return entry;
        }
        const prefix = dimmed.get(entry.text);
        return prefix === undefined ? entry : { ...entry, dimmedPrefix: prefix };
    });
}

interface AnchoredReasoning {
    /** How many durable rows precede this row. */
    readonly after: number;
    readonly entry: TuiTranscriptEntry;
}

/**
 * Thought summaries and client-only notices have no backing history message.
 * Anchor both to the count of canonical rows before them: counting a local
 * notice as durable shifts every later thought and eventually dumps it at the
 * transcript tail when the rebuilt history never reaches that count.
 */
function anchoredReasoningEntries(
    entries: readonly TuiTranscriptEntry[],
): readonly AnchoredReasoning[] {
    const anchored: AnchoredReasoning[] = [];
    let durable = 0;
    for (const entry of entries) {
        if (
            entry.kind === "thought"
            || (entry.kind !== "diff" && entry.liveOnly === true)
        ) {
            anchored.push({ after: durable, entry });
        } else if (entry.kind !== "review" && entry.kind !== "thinking") {
            durable += 1;
        }
    }
    return anchored;
}

function restoreReasoningEntries(
    base: readonly TuiTranscriptEntry[],
    anchored: readonly AnchoredReasoning[],
): readonly TuiTranscriptEntry[] {
    if (anchored.length === 0) {
        return base;
    }
    const restored: TuiTranscriptEntry[] = [];
    let durable = 0;
    let next = 0;
    const takeAnchored = (): void => {
        while (anchored[next]?.after === durable) {
            restored.push(anchored[next]!.entry);
            next += 1;
        }
    };

    takeAnchored();
    for (const entry of base) {
        restored.push(entry);
        if (entry.kind !== "review") {
            durable += 1;
            takeAnchored();
        }
    }
    // A summary can outrun the rebuilt rows when the turn ends mid-stream.
    for (; next < anchored.length; next += 1) {
        restored.push(anchored[next]!.entry);
    }
    return restored;
}

function transcriptEntriesEqual(
    left: readonly TuiTranscriptEntry[],
    right: readonly TuiTranscriptEntry[],
): boolean {
    return left.length === right.length
        && left.every((entry, index) =>
            entry.kind === right[index]?.kind
            && comparableEntryText(entry) === comparableEntryText(right[index])
            && sameAttachments(
                entryAttachments(entry),
                entryAttachments(right[index]),
            )
            && (entry.kind !== "diff"
                || (right[index]?.kind === "diff"
                    && entry.patch === right[index].patch))
        );
}

function comparableEntryText(entry: TuiTranscriptEntry | undefined): string {
    if (entry === undefined) {
        return "";
    }
    if (entry.kind !== "tool_header") {
        return entry.text;
    }
    const text = entry.text.replace(/^[+-] /, "");
    if (entry.active !== true) {
        return text;
    }
    const completed = Object.entries(LIVE_TOOL_HEADERS)
        .find(([, live]) => live === text)?.[0];
    return completed === undefined ? text : toolHeader(completed, false);
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
