import { realpathSync } from "node:fs";

import { bg, bold, fg, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

import type { AgentUpdate, AttachmentRef } from "../../src/engine/protocol.ts";
import { formatModelSubstitution } from "../../src/engine/protocol.ts";
import type {
    CompactionUpdate,
    ModelActivityUpdate,
    PoolAdmissionProgressUpdate,
    PoolAdmissionResultUpdate,
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
import type { TuiTheme } from "./theme.ts";
import type { ModelSubstitution } from "../../src/model/types.ts";
import { tuiKeyHint } from "./keymap.ts";

/** Marks the rows where the turn ran on something other than what was asked. */
const SUBSTITUTION_MARKER = "\u21c4";
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
    | "notification"
    | "extension_label"
    | "substitution"
    | "diff";

export interface TuiTextTranscriptEntry {
    readonly kind: Exclude<TuiTranscriptEntryKind, "diff">;
    readonly text: string;
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
    /** How many times in a row the same call was made. */
    readonly repeat?: number;
    /** The reasoning a `thought` summary folds away. */
    readonly reasoning?: string;
    /** Whether a `thought` summary is showing its reasoning. */
    readonly expanded?: boolean;
    /** Whether this completed tool row is hidden behind its group header. */
    readonly hidden?: boolean;
    /** How many logical output lines a folded tool header summarizes. */
    readonly detailLines?: number;
    /** Bounded leading detail retained while a tool group is folded. */
    readonly detailPreview?: string;
    /**
     * The `pool_add` request this checklist entry reports on. Progress updates
     * rewrite the entry in place rather than appending, so the checklist reads
     * as one live surface instead of one line per state change.
     */
    readonly admission?: string;
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
    /** Whether new `thought` summaries open showing their reasoning. */
    readonly thinkingExpanded?: boolean;
    /** Whether completed tool groups are forced open or closed. */
    readonly toolDetailsExpanded?: boolean;
    /** The admission run in flight, or awaiting its refreshed pool snapshot. */
    readonly admission?: TuiAdmissionState;
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
        return appendEntry(state, {
            kind: "notice",
            text: update.decision === "deny"
                ? `Reviewer denied ${update.tool}`
                    + ` (${update.riskLevel} risk): ${update.reason}`
                : `Reviewer unavailable for ${update.tool}: ${update.reason}`,
        });
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
            entries: applyToolDetailPreference(
                settleToolEntries(state.entries),
                state.toolDetailsExpanded,
            ),
            working: false,
            modelActivity: undefined,
        });
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
            entries: applyToolDetailPreference(
                settleToolEntries(state.entries),
                state.toolDetailsExpanded,
            ),
            working: false,
            queuedPrompts: [],
            modelActivity: undefined,
        }, {
            kind: "notice",
            text: `Agent error: ${update.detail}`,
        });
    }
    if (update.type === "status") {
        return {
            ...state,
            ...(update.state === "idle"
                ? {
                    entries: applyToolDetailPreference(
                        settleToolEntries(state.entries),
                        state.toolDetailsExpanded,
                    ),
                }
                : {}),
            working: update.state !== "idle",
            ...(update.state === "idle" ? { modelActivity: undefined } : {}),
        };
    }
    if (update.type === "task_notification") {
        return appendEntry(state, {
            kind: "notification",
            text: update.kind === "attention"
                ? `Async subagent ${update.sourceAgentId} needs attention:\n${update.content}`
                : `Async subagent ${update.sourceAgentId}:\n${update.content}`,
        });
    }
    if (update.type === "notice" && update.key === "inbox") {
        return appendEntry(state, {
            kind: "notification",
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
            entries: preserveLiveReviewEntries(
                state.entries,
                canonicalEntries,
            ),
            ...(update.context === undefined
                ? {}
                : { context: update.context }),
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
        }, update.settings);
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
        if (update.scope !== "effort") {
            return appendEntry(state, substitutionEntry(update));
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
        return update.warning === undefined
            ? state
            : appendTuiNotice(state, update.warning);
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
 * The pool as prose, one line per entry: what it is, at what effort, whether a
 * probe has confirmed it, and where it runs.
 */
export function tuiPoolListing(
    pooled: readonly PooledModel[] | undefined,
): string {
    if (pooled === undefined || pooled.length === 0) {
        return "Your pool is empty. ^s in the model picker adds a model to it.";
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
    return [`Pool (${pooled.length}):`, ...lines].join("\n");
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
            ? "Added to the pool"
            : `Added to the pool (${admission.verifiedLevels} ${
                admission.verifiedLevels === 1 ? "level" : "levels"
            } verified)`;
    }
    if (admission.verdict === "incompatible") {
        return `Not added, incompatible${
            admission.reason === undefined ? "" : `: ${admission.reason}`
        }`;
    }
    if (admission.verdict === "pool_write_refused") {
        return `Not added, the pool file was left untouched${
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

function admissionChecklistText(admission: TuiAdmissionState): string {
    const lines = [
        admission.verdict === undefined
            ? `Verifying ${admission.subject}…`
            : `Verifying ${admission.subject}`,
        ...tuiAdmissionStepLines(admission),
    ];
    const verdict = tuiAdmissionVerdictLine(admission);
    if (verdict !== undefined) {
        lines.push(admission.verdict === "unavailable"
            ? `${verdict}. Select the model again to retry.`
            : verdict);
    }
    return lines.join("\n");
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
        text: admissionChecklistText(admission),
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

export function appendTuiNotice(state: TuiState, message: string): TuiState {
    return appendEntry(state, { kind: "notice", text: message });
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

export function failTuiConnection(state: TuiState, message: string): TuiState {
    return appendTuiNotice({
        ...state,
        entries: applyToolDetailPreference(
            settleToolEntries(state.entries),
            state.toolDetailsExpanded,
        ),
        working: false,
        queuedPrompts: [],
    }, `Connection error: ${message}`);
}

export function appendTuiThought(state: TuiState, seconds: number): TuiState {
    const reasoning = (state.pendingThinking ?? "").trim();
    const expanded = state.thinkingExpanded === true && reasoning.length > 0;
    if (reasoning.length === 0) {
        return appendEntry(dropTuiThinking(state), {
            kind: "thought",
            text: `Thought: ${seconds.toFixed(1)}s`,
        });
    }
    return appendEntry(dropTuiThinking(state), {
        kind: "thought",
        text: thoughtSummary(seconds, expanded),
        reasoning,
        ...(expanded ? { expanded: true } : {}),
    });
}

/**
 * The fold marker doubles as the state: `+` closed, `-` open. A summary with no
 * reasoning behind it carries no marker, because there is nothing to open and a
 * marker that does nothing when pressed reads as a broken key.
 */
function thoughtSummary(seconds: number, expanded: boolean): string {
    return `${expanded ? "-" : "+"} Thought: ${seconds.toFixed(1)}s`;
}

/**
 * Drops reasoning that never reached a summary. A turn that ends without a
 * thought phase still has to clear it, or it leaks into the next one.
 */
export function dropTuiThinking(state: TuiState): TuiState {
    if (state.pendingThinking === undefined) {
        return state;
    }
    return withLiveThinking({ ...state, pendingThinking: undefined });
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
            return {
                ...entry,
                text: thoughtSummary(thoughtSeconds(entry.text), expanded),
                expanded,
            };
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

function thoughtSeconds(text: string): number {
    return Number.parseFloat(text.replace(/^[+-] Thought: /, "")) || 0;
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
        return entry.detailLines === undefined
            ? new StyledText(header)
            : new StyledText([
                ...header,
                fg(TUI_MUTED)(`  ${tuiKeyHint("toggle_tool_details")}`),
                ...(entry.detailPreview === undefined
                    ? []
                    : renderCompactToolPreview(entry.detailPreview)),
            ]);
    }
    if (entry.kind === "tool") {
        return new StyledText([
            fg(TUI_MUTED)(`${entry.prefix ?? ""}${tuiToolRowText(entry)}`),
        ]);
    }
    if (entry.kind === "substitution") {
        // Its own marker rather than a plain notice: a substitution says the
        // turn did not run on what was asked for, which outlives the run.
        return new StyledText([
            bold(fg(TUI_NOTICE)(`${SUBSTITUTION_MARKER} `)),
            fg(TUI_NOTICE)(entry.text),
        ]);
    }
    if (entry.kind === "extension_label") {
        // Styled rather than markdown: a label is a name, and a name with a
        // bracket or an asterisk in it must survive being displayed.
        return new StyledText([bold(fg(TUI_ACCENT)(entry.text))]);
    }
    if (entry.kind === "notice" || entry.kind === "review") {
        return new StyledText([fg(TUI_NOTICE)(entry.text)]);
    }
    if (entry.kind === "thought") {
        const summary = fg(TUI_NOTICE)(entry.text);
        if (entry.reasoning === undefined) {
            return new StyledText([summary]);
        }
        // The hint rides the rendered row, not the stored text, so the stored
        // summary stays the fold marker other code parses.
        const hint = fg(TUI_MUTED)(`  ${tuiKeyHint("toggle_thinking")}`);
        return entry.expanded === true
            ? new StyledText([
                summary,
                hint,
                fg(TUI_MUTED)(`\n\n${entry.reasoning}`),
            ])
            : new StyledText([summary, hint]);
    }
    return new StyledText([fg(TUI_MUTED)(entry.text)]);
}

function renderToolHeader(entry: TuiTextTranscriptEntry): TextChunk[] {
    const folded = /^([+-]) (.+?) · (\d+ lines?)$/.exec(entry.text);
    if (folded === null) {
        return [bold(fg(TUI_ACCENT)(entry.text))];
    }
    const [, marker, action, count] = folded;
    return [
        fg(TUI_ACCENT)(marker === "+" ? "• " : "▾ "),
        bold(fg(TUI_ACCENT)(action ?? "")),
        fg(TUI_MUTED)(` · ${count ?? ""}`),
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
        if (/^    \+ \d+ more lines?$/.test(line)) {
            chunks.push(fg(TUI_ACCENT)(line));
            continue;
        }
        chunks.push(fg(tone === "call" ? TUI_TEXT : TUI_MUTED)(line));
    }
    return chunks;
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
        && previous.header === header;
    if (open) {
        return [...entries, {
            kind: "tool",
            header,
            ...(active ? { tool, active: true } : {}),
            prefix: previous?.kind === "tool_header" ? "  └ " : "    ",
            text: row,
        }];
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
        text: toolResultText(output),
    });
    return completed;
}

function toolResultText(output: string): string {
    const text = output.trim();
    return text.length === 0 ? "(no output)" : bounded(text);
}

const AUTO_FOLD_TOOL_LINES = 8;
const COMPACT_TOOL_LINES = 5;
const COMPACT_TOOL_LINE_CHARS = 120;

/**
 * Completed tool groups stay compact when their content would dominate the
 * transcript. An explicit detail choice applies to every completed group;
 * active work always remains visible so the user can see what is happening.
 */
function applyToolDetailPreference(
    entries: readonly TuiTranscriptEntry[],
    preference?: boolean,
): TuiTranscriptEntry[] {
    const next = [...entries];
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
        const detailLines = rows.reduce((total, entry) =>
            total + entry.text.split("\n").length, 0
        );
        const foldable = !active
            && detailLines > 0
            && (preference !== undefined || detailLines > AUTO_FOLD_TOOL_LINES);
        const expanded = preference === true;
        const previewText = compactToolPreview(rows, detailLines);
        const base = header.header ?? header.text.replace(
            /^[+-] | · \d+ lines?$/g,
            "",
        );
        const {
            detailLines: _detailLines,
            detailPreview: _detailPreview,
            expanded: _expanded,
            ...plainHeader
        } = header;

        next[headerIndex] = foldable
            ? {
                ...plainHeader,
                text: `${expanded ? "-" : "+"} ${base} · ${detailLines} ${
                    detailLines === 1 ? "line" : "lines"
                }`,
                detailLines,
                ...(expanded || previewText === undefined
                    ? {}
                    : { detailPreview: previewText }),
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

function compactToolPreview(
    rows: readonly TuiTextTranscriptEntry[],
    detailLines: number,
): string | undefined {
    const preview: string[] = [];
    for (const row of rows) {
        const lines = tuiToolRowText(row).split("\n");
        for (let index = 0; index < lines.length; index += 1) {
            if (preview.length === COMPACT_TOOL_LINES) {
                break;
            }
            const prefix = index === 0 ? row.prefix ?? "" : "    ";
            preview.push(`${prefix}${compactToolLine(lines[index] ?? "")}`);
        }
        if (preview.length === COMPACT_TOOL_LINES) {
            break;
        }
    }
    if (preview.length === 0) {
        return undefined;
    }
    const omitted = detailLines - preview.length;
    if (omitted > 0) {
        const unit = omitted === 1 ? "line" : "lines";
        preview.push(`    + ${omitted} more ${unit}`);
    }
    return preview.join("\n");
}

function compactToolLine(line: string): string {
    const characters = Array.from(line);
    return characters.length > COMPACT_TOOL_LINE_CHARS
        ? `${characters.slice(0, COMPACT_TOOL_LINE_CHARS - 1).join("")}…`
        : line;
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
            : [...converted, toSingleTuiTranscriptEntry(entry)];
    }
    return converted;
}

function toSingleTuiTranscriptEntry(
    entry: Exclude<TranscriptEntry, { kind: "tool" | "tool_result" }>,
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
    if (entry.kind === "model_substitution") {
        return substitutionEntry(entry.substitution);
    }
    if (entry.kind === "empty") {
        return emptyTurnEntry();
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
        text: toolResultText(output),
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
    const settled = state.entries.at(-1)?.kind === "thinking"
        ? state.entries.slice(0, -1)
        : state.entries;
    const pending = state.pendingThinking;
    return {
        ...state,
        entries: pending === undefined || pending.length === 0
            ? settled
            : [...settled, { kind: "thinking", text: pending }],
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
 * A thought summary has no backing message, so a history rebuild drops it, and
 * a turn emits history while it is still streaming. Anchoring the summary to
 * the count of durable rows before it survives the rebuild and holds its place.
 */
function anchoredReasoningEntries(
    entries: readonly TuiTranscriptEntry[],
): readonly AnchoredReasoning[] {
    const anchored: AnchoredReasoning[] = [];
    let durable = 0;
    for (const entry of entries) {
        if (entry.kind === "thought") {
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
    if (entry.kind !== "tool_header" || entry.active !== true) {
        return entry.text;
    }
    const completed = Object.entries(LIVE_TOOL_HEADERS)
        .find(([, live]) => live === entry.text)?.[0];
    return completed === undefined ? entry.text : toolHeader(completed, false);
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
