import { homedir } from "node:os";

import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_SUCCESS,
    TUI_TEXT,
    type TuiEffortSubstitution,
} from "./state.ts";
import type {
    StatusLineSegment,
    StatusLineSnapshot,
} from "../../src/extensions/status-line.ts";
import { findProvider } from "../../src/providers/registry.ts";

/**
 * The facts the extension surface is handed on every repaint. Built here
 * rather than in the render pass so the snapshot stays plain data, with no
 * renderable, no session, and no client state hanging off it.
 */
export function tuiStatusSnapshot(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents: number,
    turn: StatusLineSnapshot["turn"],
): StatusLineSnapshot {
    return {
        version: 1,
        turn,
        workspace,
        runningBackgroundAgents,
        ...(settings === undefined ? {} : {
            model: {
                model: settings.model,
                ...(settings.provider === undefined
                    ? {}
                    : { provider: settings.provider }),
                ...(settings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: settings.reasoningEffort }),
            },
        }),
        ...(approvalMode === undefined ? {} : { approvalMode }),
        ...(context === undefined ? {} : {
            context: {
                tokens: context.tokens,
                estimated: context.estimated,
                ...(context.capacity === undefined
                    ? {}
                    : { capacity: context.capacity }),
            },
        }),
    };
}

/**
 * Segments carry facts, not wording. Every phrase below is the TUI's own
 * choice, so an extension reordering or dropping segments never changes how
 * this client says a thing. An unknown kind cannot reach here: the registry
 * refuses to parse it.
 */
export function renderTuiStatusSegments(
    segments: readonly StatusLineSegment[],
): string {
    return segments
        .map((segment) => renderTuiStatusSegment(segment))
        .filter((text) => text.length > 0)
        .join(" · ");
}

function renderTuiStatusSegment(segment: StatusLineSegment): string {
    switch (segment.kind) {
        case "model": {
            const label = segment.provider === undefined
                ? undefined
                : findProvider(segment.provider)?.shortLabel ?? segment.provider;
            const model = label === undefined
                ? segment.model
                : `${label}/${segment.model}`;
            return segment.reasoningEffort === undefined
                ? model
                : `${model} · reasoning ${segment.reasoningEffort}`;
        }
        case "context":
            return segment.capacity === undefined
                ? ""
                : contextUsage(
                    segment.tokens,
                    segment.capacity,
                    segment.estimated === true,
                );
        case "permissions":
            return renderPermissions(segment.mode);
        case "workspace":
            return compactWorkspace(segment.path);
        case "background_agents":
            return segment.running === 0
                ? ""
                : `${segment.running} async subagent${
                    segment.running === 1 ? "" : "s"
                } running`;
        case "turn":
            return segment.state === "idle" ? "" : segment.state;
        case "free_note":
            return segment.text;
    }
}

/**
 * A tone names what a piece of status is, not the colour it ends up. The
 * palette lives with the theme, so a client repainting under a new theme has
 * only the mapping to redo.
 */
export type TuiStatusTone =
    | "text"
    | "muted"
    | "accent"
    | "good"
    | "danger"
    | "meter"
    | "meterEmpty";

export interface TuiStatusChunk {
    readonly text: string;
    readonly tone: TuiStatusTone;
}

/**
 * What the status line says about the dials beyond the pair itself.
 *
 * `*` means the pair in force is the user's own rather than the worn agent's
 * default, and `!` means the same about the posture. Both read off a recorded
 * origin rather than a comparison done here, so the marker cannot disagree
 * with what a later agent switch will do.
 */
export interface TuiStatusDials {
    /** The worn agent, once agents exist. Absent leaves the segment off. */
    readonly agent?: string;
    readonly pairOverridden?: boolean;
    readonly postureOverridden?: boolean;
    /** The model this turn actually ran on, while a fallback is in force. */
    readonly fallbackTo?: string;
}

export function renderTuiStatusDetailsLine(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents = 0,
    substitution: TuiEffortSubstitution | undefined = undefined,
    includePermissions = true,
    branch: string | undefined = undefined,
    dials: TuiStatusDials = {},
    needsYou = 0,
    width: number | undefined = undefined,
): string {
    return renderTuiStatusDetailsRows(
        settings,
        approvalMode,
        context,
        workspace,
        runningBackgroundAgents,
        substitution,
        includePermissions,
        branch,
        dials,
        needsYou,
        width,
    )
        .map((row) => row.map((chunk) => chunk.text).join(""))
        .join("\n");
}

/**
 * The details rows as facts with tones, one array per line. Two lines, split
 * by what a narrow terminal can least afford to clip: the model, the level and
 * the context share lead, and the place the session is sitting in follows.
 */
export function renderTuiStatusDetailsRows(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents = 0,
    substitution: TuiEffortSubstitution | undefined = undefined,
    includePermissions = true,
    branch: string | undefined = undefined,
    dials: TuiStatusDials = {},
    needsYou = 0,
    width: number | undefined = undefined,
): TuiStatusChunk[][] {
    const providerLabel = settings?.provider === undefined
        ? undefined
        : findProvider(settings.provider)?.shortLabel ?? settings.provider;
    const model = settings?.model === undefined
        ? "loading"
        : providerLabel === undefined
            ? settings.model
            : `${providerLabel}/${settings.model}`;
    const requested = settings?.reasoningEffort ?? "default";
    // Requested → effective, and only while the evidence covers the model and
    // the level in effect. The setting itself is untouched: the arrow is what
    // says the two disagree, rather than the dial quietly moving.
    const substituted = substitution !== undefined
        && settings?.model === substitution.model
        && requested === substitution.requested;
    // What is running now, with what was asked for behind it: this line
    // reports the session as it stands, so the effective level leads and the
    // request is the annotation on it.
    // A settings change the host had to coerce says the same thing standing,
    // for as long as the coerced level is the one in effect: the host stops
    // sending the requested level once a change validates without coercion.
    const thinking = settings === undefined
        ? "loading"
        : substituted
            ? `${substitution!.effective ?? "none"} (asked ${requested})`
            : settings.requestedReasoningEffort === undefined
                ? requested
                : `${requested} (asked ${settings.requestedReasoningEffort})`;
    const permissions = approvalMode === undefined
        ? "permissions loading"
        : renderPermissions(approvalMode);
    // The guaranteed way to find out that something is waiting. Terminal
    // notifications are best effort and the Work tab has to be opened; this is
    // always on screen, so it leads the row, and names the command that
    // answers it. On a row too narrow for both, the count stays and the
    // command goes: the count is the alarm, the command is the directions.
    const attention = (hint: boolean): TuiStatusChunk[] =>
        needsYou === 0 ? [] : [
            { text: `${needsYou} need you`, tone: "danger" as const },
            ...(hint
                ? [separator, { text: "/work", tone: "danger" as const }]
                : []),
            separator,
        ];
    const background = runningBackgroundAgents === 0
        ? []
        : [
            muted(
                `${runningBackgroundAgents} async subagent${
                    runningBackgroundAgents === 1 ? "" : "s"
                } running`,
            ),
            separator,
        ];
    // The level is the word on its own: the dial it belongs to is named
    // wherever it is changed, and repeating it here spends columns the context
    // share needs.
    const afterAttention: TuiStatusChunk[] = [
        ...background,
        ...(dials.agent === undefined ? [] : [
            {
                text: `${dials.agent}${
                    dials.postureOverridden === true ? "!" : ""
                }`,
                tone: "accent",
            } as TuiStatusChunk,
            separator,
        ]),
        {
            text: dials.fallbackTo === undefined
                ? model
                : `${model}→${dials.fallbackTo}`,
            tone: "text",
        },
        ...(dials.pairOverridden === true
            ? [{ text: "*", tone: "accent" } as TuiStatusChunk]
            : []),
        separator,
        muted(thinking.toUpperCase()),
        ...contextChunks(context),
        ...(includePermissions
            ? [separator, {
                text: permissions,
                tone: permissionsTone(approvalMode),
            } as TuiStatusChunk]
            : []),
    ];
    const rowWidth = (chunks: readonly TuiStatusChunk[]): number =>
        chunks.reduce((total, chunk) => total + chunk.text.length, 0);
    let first: TuiStatusChunk[] = [...attention(true), ...afterAttention];
    if (width !== undefined && needsYou > 0 && rowWidth(first) > width) {
        first = [...attention(false), ...afterAttention];
    }
    const second: TuiStatusChunk[] = [
        muted(compactWorkspace(workspace)),
        ...(branch === undefined
            ? []
            : [separator, { text: branch, tone: "accent" } as TuiStatusChunk]),
    ];
    return [first, second];
}

/**
 * How many columns of the first details row the attention chip covers, hint
 * included when it survived the width fit: the span a client should treat as
 * the click target for opening the Work tab.
 */
export function needsYouChipColumns(
    row: readonly TuiStatusChunk[],
    needsYou: number,
): number {
    if (needsYou === 0 || row[0]?.tone !== "danger") return 0;
    let columns = row[0].text.length;
    if (row[2]?.text === "/work") {
        columns += (row[1]?.text.length ?? 0) + row[2].text.length;
    }
    return columns;
}

/**
 * Read at paint time rather than captured: the theme is swapped in place, and
 * a colour resolved once would keep the palette the session started under.
 */
export function statusToneColor(tone: TuiStatusTone): string {
    switch (tone) {
        case "text":
            return TUI_TEXT;
        case "muted":
            return TUI_MUTED;
        case "accent":
        case "meter":
            return TUI_ACCENT;
        case "good":
            return TUI_SUCCESS;
        case "danger":
            return FULL_ACCESS_RED;
        case "meterEmpty":
            return TUI_ELEMENT;
    }
}

const FULL_ACCESS_RED = "#ff3b30";

const separator: TuiStatusChunk = { text: " · ", tone: "muted" };

function muted(text: string): TuiStatusChunk {
    return { text, tone: "muted" };
}

/**
 * Absent until the engine has measured something. A session that has not sent
 * a request has no honest percentage to show: its prompt and tool definitions
 * already occupy the window, so "0%" would be a number nobody measured.
 */
function contextChunks(
    context: ContextMeasurement | undefined,
): TuiStatusChunk[] {
    if (context?.capacity === undefined) return [];
    const { tokens, capacity, estimated } = context;
    const percent = Math.min(100, Math.round(tokens / capacity * 100));
    const filled = Math.min(8, Math.round(percent / 100 * 8));
    return [
        separator,
        muted(
            `ctx ${estimated ? "~" : ""}${formatTokenCount(tokens)}/${
                formatTokenCount(capacity)
            } [`,
        ),
        { text: "█".repeat(filled), tone: "meter" },
        { text: "░".repeat(8 - filled), tone: "meterEmpty" },
        muted(`] ${percent}%`),
    ];
}

function permissionsTone(
    mode: ApprovalMode | undefined,
): TuiStatusTone {
    if (mode === undefined) return "muted";
    return mode === "full_access" ? "danger" : mode === "ask" ? "muted" : "good";
}

/**
 * The idle status line, which reports background work when there is any.
 *
 * An idle session with children still out looks identical to a finished one,
 * so the quiet is what needs explaining. The palette hint rides along because
 * the idle line is the only place that chord is advertised.
 */
export function renderTuiIdleHint(
    readyHint: string,
    runningBackgroundAgents: number,
): string {
    if (runningBackgroundAgents <= 0) {
        return readyHint;
    }
    const agents = `${runningBackgroundAgents} background agent${
        runningBackgroundAgents === 1 ? "" : "s"
    }`;
    return `waiting for ${agents} · ${readyHint}`;
}

function compactWorkspace(workspace: string): string {
    const home = homedir();
    return workspace === home
        ? "~"
        : workspace.startsWith(`${home}/`)
            ? `~/${workspace.slice(home.length + 1)}`
            : workspace;
}

/**
 * The tilde is the estimate label. Vera counts characters until a provider
 * reports its own total, and a percentage that hides which of the two it is
 * reads as precise when it is not.
 */
function contextUsage(
    tokens: number,
    capacity: number,
    estimated: boolean,
): string {
    const percent = Math.min(100, Math.round(tokens / capacity * 100));
    const filled = Math.min(8, Math.round(percent / 100 * 8));
    const meter = `${"█".repeat(filled)}${"░".repeat(8 - filled)}`;
    return `ctx ${estimated ? "~" : ""}${formatTokenCount(tokens)}/${formatTokenCount(capacity)} [${meter}] ${percent}%`;
}

function formatTokenCount(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000;
    const suffix = divisor === 1_000 ? "k" : "m";
    const compact = Math.round(tokens / divisor * 10) / 10;
    return `${compact}${suffix}`;
}

function renderPermissions(mode: string): string {
    return mode === "full_access" ? "FULL ACCESS · RED ZONE" : mode;
}
