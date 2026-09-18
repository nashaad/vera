import { workedDividerText } from "./worked-divider.ts";
import type { TurnTiming } from "../../src/model/types.ts";
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
import type { ModelSubstitution } from "../../src/model/types.ts";
import { tuiKeyChordLabel, tuiKeyHint } from "./keymap.ts";
import {
    resolveTuiDiagnostic,
    type TuiDiagnostic,
    type TuiDiagnosticCode,
} from "./diagnostic-severity.ts";

const SUBSTITUTION_MARKER = "\u21c4";
const INTERRUPTED_TURN_TEXT = "Interrupted";

/** The palette lives in `palette.ts`, which knows nothing about sessions. Imported for this module's own rendering and re-exported because most views take state and colour together. */
import {
    applyTuiTheme,
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_CHROME,
    TUI_CRITICAL,
    TUI_DANGER,
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
    TUI_ELEMENT,
    TUI_HUD,
    TUI_INPUT,
    TUI_MENU,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SELECTION_TEXT,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./palette.ts";

export type TuiTranscriptEntryKind =
    | "user"
    | "assistant"
    | "tool"
    | "tool_header"
    | "thinking"
    | "worked"
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
    readonly entryId?: string;
    // Rows derived from a session's import facts; rebuilt, never stored.
    readonly importRow?: true;
    readonly attachments?: readonly string[];
    readonly header?: string;
    readonly tool?: string;
    readonly active?: boolean;
    readonly result?: boolean;
    readonly hasResult?: boolean;
    readonly dimmedPrefix?: number;
    readonly prefix?: string;
    readonly repeat?: number;
    readonly supersedes?: string;
    readonly liveOnly?: boolean;
    readonly reasoning?: string;
    readonly seconds?: number;
    readonly expanded?: boolean;
    readonly hidden?: boolean;
    readonly detailLines?: number;
    readonly detailPreview?: string;
    readonly command?: string;
    readonly hint?: boolean;
    readonly admission?: string;
    readonly diagnostic?: TuiDiagnostic;
    readonly tone?: "primary" | "soft" | "error" | "success";
    readonly card?: boolean;
    readonly summary?: string;
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

export interface TuiEffortSubstitution {
    readonly model: string;
    readonly requested: string;
    readonly effective?: string;
}

export interface TuiQueuedPrompt {
    readonly content: string;
    readonly state: "held" | "released";
}

export interface TuiState {
    readonly entries: readonly TuiTranscriptEntry[];
    readonly working: boolean;
    readonly transcriptStarted?: boolean;
    readonly reopenedTurnFinishedAt?: number;
    readonly queuedPrompts: readonly TuiQueuedPrompt[];
    readonly queueDraining: boolean;
    readonly modelSettings?: ModelTurnSettings;
    readonly approvalMode?: ApprovalMode;
    readonly permissionInspection?: PermissionInspection;
    readonly context?: ContextMeasurement;
    readonly modelActivity?: ModelActivityUpdate;
    readonly sessionUsage?: SessionModelUsage;
    readonly extensionState?: import("../../src/extensions/session-state.ts").ExtensionSessionStates;
    readonly pendingThinking?: string;
    readonly effortSubstitution?: TuiEffortSubstitution;
    readonly turnSubstituted?: boolean;
    readonly modelFallback?: { readonly from: string; readonly to: string };
    readonly thinkingExpanded?: boolean;
    readonly toolDetailsExpanded?: boolean;
    readonly admission?: TuiAdmissionState;
    readonly modelSettingsHistory?: readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: "agent-default" | "user";
        readonly timestamp: string;
    }[];
    readonly modelSettingsOrigin?: "agent-default" | "user";
    readonly approvalModeOrigin?: "agent-default" | "user";
    readonly compactingSince?: number;
    readonly compactionStrategy?: string;
    readonly compactionProvider?: string;
    readonly compactionModel?: string;
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

export interface TuiAdmissionState {
    readonly requestId: string;
    readonly subject: string;
    readonly steps: readonly TuiAdmissionStep[];
    readonly verdict?: PoolAdmissionVerdict;
    readonly provider?: string;
    readonly model?: string;
    readonly reason?: string;
    readonly statusCode?: number;
    readonly verifiedLevels?: number;
    readonly settled?: boolean;
}


export {
    applyTuiTheme,
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_CHROME,
    TUI_CRITICAL,
    TUI_DANGER,
    TUI_DIFF_ADDED,
    TUI_DIFF_REMOVED,
    TUI_ELEMENT,
    TUI_HUD,
    TUI_INPUT,
    TUI_MENU,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SELECTION_TEXT,
    TUI_SUCCESS,
    TUI_TEXT,
};

export function attachmentLabel(attachment: AttachmentRef): string {
    return attachment.name ?? "attached image";
}

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
        queueDraining: false,
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
        transcriptStarted: true,
    };
}

export function queueTuiPrompt(state: TuiState, prompt: string): TuiState {
    return {
        ...state,
        queuedPrompts: [
            ...state.queuedPrompts,
            { content: prompt, state: "held" as const },
        ],
    };
}

export function beginNextQueuedTuiTurn(state: TuiState): TuiState {
    const [prompt, ...queuedPrompts] = state.queuedPrompts;
    if (prompt === undefined) {
        return state;
    }

    return {
        ...state,
        entries: [...state.entries, { kind: "user", text: prompt.content }],
        working: true,
        transcriptStarted: true,
        queuedPrompts,
    };
}

function toTuiQueuedPrompt(
    prompt: { readonly content: string; readonly state?: "held" | "released" },
): TuiQueuedPrompt {
    return { content: prompt.content, state: prompt.state ?? "held" };
}

export function renderTuiQueuedPrompt(state: TuiState): string {
    const prompt = state.queuedPrompts[0];
    if (prompt === undefined) {
        return "";
    }

    const summary = prompt.content.replace(/\s+/g, " ").trim();
    const compact = summary.length > 48
        ? `${summary.slice(0, 47)}…`
        : summary;
    const remaining = state.queuedPrompts.length - 1;
    const phase = prompt.state === "released" ? "sending" : "queued";
    return `${phase} · ${compact}${remaining === 0 ? "" : ` · +${remaining}`}`;
}

export function applyAgentUpdate(state: TuiState, update: AgentUpdate): TuiState {
    if (update.type === "prompt_queue") {
        return {
            ...state,
            queuedPrompts: update.queue.prompts.map(toTuiQueuedPrompt),
            queueDraining: update.queue.draining,
        };
    }
    if (update.type === "model_activity") {
        const next = update.replacesPartialAttempt === true
            ? discardPartialModelAttempt(state)
            : state;
        return { ...next, modelActivity: update };
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
            entries: applyToolDetailPreference(
                withToolEntry(state.entries, update.tool, update.args, true),
                state.toolDetailsExpanded,
            ),
        };
    }
    if (update.type === "tool_review") {
        if (update.decision === "allow") {
            return appendEntry(state, {
                kind: "review",
                text: `Classifier allowed ${update.tool}`
                    + ` (risk: ${update.riskLevel},`
                    + ` authorization: ${update.userAuthorization}):`
                    + ` ${update.reason}`,
            });
        }
        const message = update.decision === "deny"
            ? `Classifier denied ${update.tool}`
                + ` (${update.riskLevel} risk): ${update.reason}`
            : update.reason
                === "The turn was cancelled before classification finished."
                ? `Classification cancelled for ${update.tool}.`
                    + " The action did not run."
                : `Classifier failed for ${update.tool}: ${update.reason}`;
        return appendTuiDiagnostic(
            state,
            update.decision === "deny" ? "permission_denied" : "unknown",
            message,
        );
    }
    if (update.type === "tool_breaker_tripped") {
        return appendEntry(state, {
            kind: "notice",
            text: update.action === "withheld"
                ? `[breaker] ${update.tool} withheld for the rest of this turn`
                    + ` after ${update.denials} refusals in a row`
                : `[breaker] turn ended: ${update.tool} was refused`
                    + ` ${update.denials} times in a row after another tool`
                    + " was already withheld",
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
        let finished = clearedSubstitution({
            ...state,
            entries: settleTrailingThoughts(applyToolDetailPreference(
                settleToolEntries(state.entries),
                state.toolDetailsExpanded,
            )),
            working: false,
            transcriptStarted: true,
            modelActivity: undefined,
            compactingSince: undefined,
            compactionStrategy: undefined,
            compactionProvider: undefined,
            compactionModel: undefined,
            ...(update.usage === undefined
                ? {}
                : { sessionUsage: update.usage }),
            extensionState: update.extensionState ?? {},
        });
        if (update.empty === true) {
            finished = appendEntry(finished, emptyTurnEntry());
        } else if (update.outcome === "aborted") {
            finished = appendTuiDiagnostic(
                finished,
                "turn_interrupted",
                INTERRUPTED_TURN_TEXT,
            );
        } else {
            const error = update.error
                ?? (update.outcome === "error" ? "Model request failed" : undefined);
            if (error !== undefined) {
                const attachment = error.startsWith("Image attachment unavailable:");
                finished = appendTuiDiagnostic(
                    finished,
                    attachment ? "attachment_failed" : "model_request_failed",
                    attachment
                        ? `Attachment error: ${error.slice("Image attachment unavailable:".length).trim()}`
                        : `Model error: ${error}`,
                );
            }
        }
        return update.turnTiming !== undefined
            && (update.turnTiming.durationMs >= WORKED_DIVIDER_THRESHOLD_MS
                || update.outcome !== undefined || update.error !== undefined)
            ? appendWorkedDivider(finished, update.turnTiming)
            : finished;
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
            queueDraining: false,
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
    if (update.type === "notice" && update.key === "queue_release_empty") {
        return appendEntry(state, {
            kind: "notice",
            text:
                "Nothing left to release: every queued prompt is already running",
        });
    }
    if (update.type === "notice") {
        return update.text === undefined ? state : appendEntry(state, { kind: "notice", text: update.text });
    }
    if (update.type === "history") {
        const reopenedTurnFinishedAt = state.transcriptStarted === true
            || state.working || (update.status !== undefined && update.status !== "idle")
            ? state.reopenedTurnFinishedAt
            : update.entries.findLast((entry) => entry.kind !== "harness")
                ?.turnTiming?.finishedAt;
        const canonicalEntries = applyToolDetailPreference(
            toTuiTranscriptEntries(update.entries, reopenedTurnFinishedAt),
            state.toolDetailsExpanded,
        );
        return withLiveThinking({
            ...state,
            transcriptStarted: state.transcriptStarted === true || update.entries.length > 0,
            reopenedTurnFinishedAt,
            entries: settleTrailingThoughts(foldAdjacentThoughts(
                hoistStrandedThoughts(
                    preserveLiveReviewEntries(state.entries, canonicalEntries),
                ),
            )),
            ...(update.context === undefined
                ? {}
                : {
                    context: keepLastContextRecipe(
                        update.context,
                        state.context,
                    ),
                }),
            ...(update.usage === undefined
                ? {}
                : { sessionUsage: update.usage }),
            extensionState: update.extensionState ?? {},
            ...(update.promptQueue === undefined
                ? {}
                : {
                    queuedPrompts: update.promptQueue.prompts.map(
                        toTuiQueuedPrompt,
                    ),
                    queueDraining: update.promptQueue.draining,
                }),
            ...(update.status === undefined
                ? {}
                : { working: update.status !== "idle" }),
        });
    }
    if (update.type === "context") {
        return { ...state, context: update.measurement };
    }
    if (update.type === "user_prompt") {
        const nextState = {
            ...state,
            transcriptStarted: true,
            working: true,
            modelActivity: undefined,
        };
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
            ...(appliesToSettings(state.effortSubstitution, update.settings)
                ? state
                : { ...state, effortSubstitution: undefined }),
            modelSettings: update.settings,
            ...(update.origin === undefined
                ? {}
                : { modelSettingsOrigin: update.origin }),
        }, update.settings);
    }
    if (update.type === "agent_selected") {
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
        return appendTuiNotice(
            next,
            update.notice ?? `Switched to ${update.name}.`,
            "soft",
        );
    }
    if (update.type === "customization_sources") return state;
    if (update.type === "agent_catalog") {
        return state;
    }
    if (update.type === "agent_rejected") {
        return appendTuiNotice(state, update.reason);
    }
    if (
        update.type === "skill_catalog"
        || update.type === "skill_invocation_accepted"
        || update.type === "skill_invocation_rejected"
    ) {
        return state;
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
        return state;
    }
    if (update.type === "permissions") {
        const next = {
            ...state,
            approvalMode: update.mode,
            ...(update.inspection === undefined
                ? {}
                : { permissionInspection: update.inspection }),
            ...(update.origin === undefined
                ? {}
                : { approvalModeOrigin: update.origin }),
        };
        return update.warning === undefined
            ? next
            : appendTuiNotice(next, update.warning);
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
        update.type === "oneshot_result"
        || update.type === "oneshot_rejected"
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
        return appendTuiNotice({ ...state, working: false }, update.reason);
    }
    if (update.type === "compaction") {
        return applyCompaction(state, update);
    }
    if (update.type === "model_substitution") {
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
        return sameSubstitution(state.effortSubstitution, substitution)
            ? next
            : appendEntry(next, substitutionEntry(update));
    }
    return assertNever(update);
}

function discardPartialModelAttempt(state: TuiState): TuiState {
    const withoutLiveThinking = dropTuiThinking(state);
    const entries = [...withoutLiveThinking.entries];
    if (entries.at(-1)?.kind === "assistant") {
        entries.pop();
    }
    while (entries.at(-1)?.kind === "thought") {
        entries.pop();
    }
    return { ...withoutLiveThinking, entries };
}

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

function foldThoughts(
    thoughts: readonly TuiTextTranscriptEntry[],
): readonly TuiTextTranscriptEntry[] {
    const first = thoughts[0];
    if (first === undefined) {
        return thoughts;
    }
    return [thoughts.slice(1).reduce(mergeThoughts, first)];
}

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
        // A refused manual request. It had no started phase of its own, so it must not clear the mark of a compaction that is still running.
        return appendTuiNotice(
            state,
            "Compaction runs between turns. Try again once this one finishes.",
        );
    }
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
    const settled: TuiAdmissionState = update.verdict === "added"
        ? next
        : { ...next, settled: true };
    return withAdmissionEntry({ ...state, admission: settled }, settled);
}

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

function admissionStepMark(status: TuiAdmissionStep["status"]): string {
    if (status === "running") return "…";
    if (status === "passed") return "✓";
    if (status === "failed") return "✗";
    return "−";
}

export function tuiAdmissionStepLines(
    admission: TuiAdmissionState,
): readonly string[] {
    return admission.steps.map((step) => {
        const detail = step.detail === undefined ? "" : `: ${step.detail}`;
        const skipped = step.status === "skipped" ? " (skipped)" : "";
        return `  ${admissionStepMark(step.status)} ${step.label}${skipped}${detail}`;
    });
}

export function tuiPoolListing(
    pooled: readonly PooledModel[] | undefined,
): string {
    if (pooled === undefined || pooled.length === 0) {
        return "You have no favorites yet. Ctrl+S in the model picker keeps one.";
    }
    const lines = pooled.map((entry) => {
        const effort = entry.defaultLevel ?? "provider default";
        const state = entry.verified ? "verified" : "unverified";
        const availability = entry.available ? "" : ", unavailable right now";
        const named = entry.poolName === undefined
            ? entry.model
            : `${entry.poolName} (${entry.model})`;
        return `  ${named} · ${effort} · ${state} · ${entry.provider}${availability}`;
    });
    return [`Favorites (${pooled.length}):`, ...lines].join("\n");
}

export function tuiAdmissionVerdictLine(
    admission: TuiAdmissionState,
): string | undefined {
    if (admission.verdict === "added") {
        return admission.verifiedLevels === undefined
            ? "Kept in your favorites"
            : `Kept in your favorites (${admission.verifiedLevels} ${
                admission.verifiedLevels === 1 ? "level" : "levels"
            } verified)`;
    }
    if (admission.verdict === "incompatible") {
        return `Not pinned, incompatible${
            admission.reason === undefined ? "" : `: ${admission.reason}`
        }`;
    }
    if (admission.verdict === "pool_write_refused") {
        return `Not kept, your favorites were left untouched${
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

/** The one checklist entry for this request, rewritten in place as its steps change state. */
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

function appliesToSettings(
    substitution: TuiEffortSubstitution | undefined,
    settings: ModelTurnSettings | undefined,
): boolean {
    return substitution !== undefined
        && settings?.model === substitution.model
        && (settings.reasoningEffort ?? "default") === substitution.requested;
}

function clearedSubstitution(state: TuiState): TuiState {
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
    tone?: "primary" | "soft" | "error" | "success",
    supersedes?: string,
): TuiState {
    return placeTuiNotice(state, {
        kind: "notice",
        text: message,
        liveOnly: true,
        ...(tone === undefined ? {} : { tone }),
        ...(supersedes === undefined ? {} : { supersedes }),
    });
}

// A card notice renders as a shaded band instead of a bare line.
export function appendTuiNoticeCard(
    state: TuiState,
    message: string,
    summary: string,
    supersedes: string,
): TuiState {
    return placeTuiNotice(state, {
        kind: "notice",
        text: message,
        summary,
        liveOnly: true,
        card: true,
        expanded: state.toolDetailsExpanded === true,
        supersedes,
    });
}

function placeTuiNotice(state: TuiState, entry: TuiTextTranscriptEntry): TuiState {
    const previous = state.entries.at(-1);
    if (
        entry.supersedes !== undefined && previous?.kind === "notice"
        && previous.supersedes === entry.supersedes
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

// The lines a superseding card carries forward, minus its trailing footer.
export function tuiNoticeCardLines(
    state: TuiState,
    supersedes: string,
    footer: string,
): readonly string[] {
    const previous = state.entries.at(-1);
    if (
        previous?.kind !== "notice" || previous.card !== true
        || previous.supersedes !== supersedes
    ) {
        return [];
    }
    return previous.text.split("\n").filter((line) => line !== footer);
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

export function appendTuiError(state: TuiState, message: string): TuiState {
    return appendTuiDiagnostic(state, "unknown", message);
}

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

export function failTuiConnection(state: TuiState): TuiState {
    return {
        ...state,
        entries: applyToolDetailPreference(
            settleToolEntries(state.entries),
            state.toolDetailsExpanded,
        ),
        working: false,
        queueDraining: false,
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

function thoughtSummary(seconds: number): string {
    return `Reasoning: ${seconds.toFixed(1)}s`;
}

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
        (entry.kind === "tool"
            && entry.active !== true
            && entry.hidden !== true)
        || (entry.kind === "notice" && entry.card === true
            && entry.expanded === true)
    );
    return {
        ...state,
        toolDetailsExpanded: expanded,
        entries: applyToolDetailPreference(state.entries, expanded).map((entry) =>
            entry.kind === "notice" && entry.card === true
                ? { ...entry, expanded }
                : entry
        ),
    };
}

export function renderTuiEntry(entry: TuiTranscriptEntry): StyledText {
    if (entry.kind === "diff") {
        return new StyledText([fg(TUI_MUTED)(entry.text)]);
    }
    if (entry.kind === "user") {
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
                ...(entry.hint === true
                    ? [fg(TUI_MUTED)(`  ${tuiKeyHint("toggle_tool_details")}`)]
                    : []),
                ...(entry.detailPreview === undefined
                    ? []
                    : renderCompactToolPreview(entry.detailPreview)),
            ]);
    }
    if (entry.kind === "tool") {
        return renderTuiToolRow(entry);
    }
    if (entry.kind === "substitution") {
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
        return new StyledText([bold(fg(TUI_ACCENT)(entry.text))]);
    }
    if (entry.kind === "review") {
        return new StyledText(renderTuiReview(entry.text));
    }
    if (entry.kind === "notice") {
        if (entry.card === true) {
            return entry.expanded === true
                ? new StyledText([fg(TUI_MUTED)(entry.text)])
                : new StyledText([
                    fg(TUI_MUTED)(entry.summary ?? entry.text),
                    fg(TUI_MUTED)(`  ${tuiKeyHint("toggle_tool_details")}`),
                ]);
        }
        if (entry.diagnostic === undefined && entry.admission !== undefined) {
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
                : entry.tone === "success"
                ? TUI_SUCCESS
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
        const summary = fg(TUI_MUTED)(entry.text);
        if (entry.reasoning === undefined) {
            return new StyledText([summary]);
        }
        const hint = fg(TUI_MUTED)(
            entry.expanded === true
                ? `  ${tuiKeyChordLabel("toggle_thinking")} hide reasoning`
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
        const tail = liveThinkingTail(entry.text);
        return new StyledText([
            fg(TUI_MUTED)(
                tail.length === 0
                    ? LIVE_THINKING_ELLIPSIS
                    : `${LIVE_THINKING_ELLIPSIS} ${tail}`,
            ),
        ]);
    }
    return new StyledText([fg(TUI_MUTED)(entry.text)]);
}

export const LIVE_THINKING_ROWS = 1;

export const LIVE_THINKING_ELLIPSIS = "···";

function liveThinkingTail(text: string): string {
    const lines = plainReasoningSummary(text)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
    return lines.slice(-LIVE_THINKING_ROWS).join("\n");
}

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

function renderTuiReview(text: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const approvalPrefix = "Classifier ";
    if (!text.startsWith(approvalPrefix)) {
        return text.length === 0 ? [] : [fg(TUI_MUTED)(text)];
    }
    chunks.push(fg(TUI_MUTED)(approvalPrefix));

    let remaining = text.slice(approvalPrefix.length);
    const allowed = "allowed";
    if (!remaining.startsWith(allowed)) {
        chunks.push(fg(TUI_MUTED)(remaining));
        return chunks;
    }
    chunks.push(fg(TUI_SUCCESS)(allowed));
    remaining = remaining.slice(allowed.length);

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
        return [fg(TUI_MUTED)("  "), bold(fg(TUI_TEXT)(entry.text))];
    }
    const [, marker, action] = folded;
    return [
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

export function tuiToolRowText(entry: TuiTextTranscriptEntry): string {
    const repeat = entry.repeat ?? 1;
    return repeat > 1 ? `${entry.text} ×${repeat}` : entry.text;
}

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

export function renderTuiToolRow(
    entry: TuiTextTranscriptEntry,
): StyledText {
    return new StyledText([
        fg(TUI_MUTED)(entry.prefix ?? ""),
        ...renderTuiToolRowChunks(entry),
    ]);
}

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
    if (
        current?.kind === "notice" && previous?.kind === "notice"
        && current.diagnostic === undefined && previous.diagnostic === undefined
        && current.admission === undefined && previous.admission === undefined
        && current.tone === previous.tone
    ) {
        return 0;
    }
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

export function setTuiWorkspaceRoot(workspace: string): void {
    const roots = [workspace];
    try {
        const resolved = realpathSync(workspace);
        if (resolved !== workspace) {
            roots.push(resolved);
        }
    } catch {
    }
    tuiWorkspaceRoots = roots;
}

export function tuiDisplayPath(path: string): string {
    for (const root of tuiWorkspaceRoots) {
        const prefix = root.endsWith("/") ? root : `${root}/`;
        if (path.startsWith(prefix)) {
            return path.slice(prefix.length);
        }
    }
    return path;
}

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

function withToolEntry(
    entries: readonly TuiTranscriptEntry[],
    tool: string,
    args: Readonly<Record<string, unknown>>,
    active: boolean,
): TuiTranscriptEntry[] {
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
    }
    return bounded(output);
}

const COMPACT_TOOL_LINE_CHARS = 96;

function applyToolDetailPreference(
    entries: readonly TuiTranscriptEntry[],
    preference?: boolean,
): TuiTranscriptEntry[] {
    const next = [...entries];
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
        const foldable = detailLines > 0
            && (active || hasResult || preference !== undefined);
        const expanded = preference === true;
        const calls = active ? liveToolCallLines(rows) : toolCallLines(rows);
        const summary = active
            ? liveToolSummary(calls)
            : compactToolSummary(rows, calls);
        const base = header.header ?? header.text.replace(/^[+-] /, "");
        const {
            detailLines: _detailLines,
            detailPreview: _detailPreview,
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
                text: active ? base : `${expanded ? "-" : "+"} ${base}`,
                detailLines,
                ...(!expanded && calls.length === 1 && calls[0] !== undefined
                    ? { command: compactToolLine(calls[0]) }
                    : {}),
                ...(expanded || summary === undefined
                    ? {}
                    : {
                        detailPreview: summary,
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

function toolCallLines(
    rows: readonly TuiTextTranscriptEntry[],
): readonly string[] {
    return rows
        .filter((row) => row.prefix === "  │ ")
        .map((row) => tuiToolRowText(row).replace(/\s+/g, " ").trim())
        .filter((line) => line.length > 0);
}

function liveToolCallLines(
    rows: readonly TuiTextTranscriptEntry[],
): readonly string[] {
    return rows
        .filter((row) => row.result !== true)
        .map((row) => tuiToolRowText(row).replace(/\s+/g, " ").trim())
        .filter((line) => line.length > 0);
}

function liveToolSummary(calls: readonly string[]): string | undefined {
    if (calls.length === 0) return undefined;
    return `  └ ${compactToolLine(compactFoldedCalls([...calls]).join(", "))}`;
}

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

const WORKED_DIVIDER_THRESHOLD_MS = 5 * 60 * 1_000;

function toTuiTranscriptEntries(
    entries: readonly TranscriptEntry[],
    reopenedTurnFinishedAt?: number,
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
        if (entry.turnTiming !== undefined
            && (entry.turnTiming.durationMs >= WORKED_DIVIDER_THRESHOLD_MS
                || entry.kind === "error"
                || entry.turnTiming.finishedAt === reopenedTurnFinishedAt)) {
            converted.push(workedDividerEntry(entry.turnTiming));
        }
    }
    return converted;
}

function withStoreEntryId(
    converted: TuiTranscriptEntry,
    entry: TranscriptEntry,
): TuiTranscriptEntry {
    const id = "id" in entry ? entry.id : undefined;
    return id === undefined || converted.kind === "diff"
        ? converted
        : { ...converted, entryId: id };
}

export function transcriptMessageId(
    entryId: string | undefined,
): string | undefined {
    if (entryId === undefined) return undefined;
    const suffix = entryId.lastIndexOf("#");
    return suffix === -1 ? entryId : entryId.slice(0, suffix);
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

function workedDividerEntry(timing: TurnTiming): TuiTextTranscriptEntry {
    return { kind: "worked", text: workedDividerText(timing) };
}

function appendWorkedDivider(state: TuiState, timing: TurnTiming): TuiState {
    const entry = workedDividerEntry(timing);
    const last = state.entries.at(-1);
    return last?.kind === "worked" && last.text === entry.text
        ? state
        : appendEntry(state, entry);
}

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
    readonly after: number;
    readonly entry: TuiTranscriptEntry;
}

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

function keepLastContextRecipe(
    incoming: ContextMeasurement,
    live: ContextMeasurement | undefined,
): ContextMeasurement {
    if (
        incoming.projection !== undefined
        || live?.projection === undefined
    ) {
        return incoming;
    }
    return { ...incoming, projection: live.projection };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled agent update: ${JSON.stringify(value)}`);
}
