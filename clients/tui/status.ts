import { modelSelectionCleared } from "../../src/host/model-catalog-settings.ts";
import { homedir } from "node:os";

import {
    effectiveContextWindow,
    type ModelTurnSettings,
} from "../../src/engine/model-settings.ts";
import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import {
    TUI_ACCENT,
    TUI_CRITICAL,
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

export function tuiStatusSnapshot(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents: number,
    turn: StatusLineSnapshot["turn"],
): StatusLineSnapshot {
    const capacity = visibleContextCapacity(settings, context);
    return {
        version: 1,
        turn,
        workspace,
        runningBackgroundAgents,
        ...(settings === undefined || modelSelectionCleared(settings) ? {} : {
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
                ...(capacity === undefined ? {} : { capacity }),
            },
        }),
    };
}

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

export interface TuiStatusDials {
    readonly agent?: string;
    readonly pairOverridden?: boolean;
    readonly postureOverridden?: boolean;
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
    needsYouHint = "/work",
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
        needsYouHint,
    )
        .map((row) => row.map((chunk) => chunk.text).join(""))
        .join("\n");
}

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
    needsYouHint = "/work",
): TuiStatusChunk[][] {
    const providerLabel = settings?.provider === undefined
        ? undefined
        : findProvider(settings.provider)?.shortLabel ?? settings.provider;
    const model = modelSelectionCleared(settings) ? "no model selected" : settings?.model === undefined
        ? "loading"
        : providerLabel === undefined
            ? settings.model
            : `${providerLabel}/${settings.model}`;
    const requested = modelSelectionCleared(settings) ? "default" : settings?.reasoningEffort ?? "default";
    const substituted = substitution !== undefined
        && settings?.model === substitution.model
        && requested === substitution.requested;
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
    const attention = (hint: boolean): TuiStatusChunk[] =>
        needsYou === 0 ? [] : [
            { text: `${needsYou} need you`, tone: "danger" as const },
            ...(hint && needsYouHint !== ""
                ? [separator, { text: needsYouHint, tone: "danger" as const }]
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
        ...contextChunks(context, settings),
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

export function renderTuiFileViewStatusRows(
    workspace: string,
    branch: string | undefined = undefined,
): TuiStatusChunk[][] {
    return [
        [],
        [
            muted(compactWorkspace(workspace)),
            ...(branch === undefined
                ? []
                : [separator, { text: branch, tone: "accent" as const }]),
        ],
    ];
}

export function needsYouChipColumns(
    row: readonly TuiStatusChunk[],
    needsYou: number,
): number {
    if (needsYou === 0 || row[0]?.tone !== "danger") return 0;
    let columns = row[0].text.length;
    if (row[2]?.tone === "danger") {
        columns += (row[1]?.text.length ?? 0) + row[2].text.length;
    }
    return columns;
}

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
            return TUI_CRITICAL;
        case "meterEmpty":
            return TUI_ELEMENT;
    }
}

const separator: TuiStatusChunk = { text: " · ", tone: "muted" };

function muted(text: string): TuiStatusChunk {
    return { text, tone: "muted" };
}

export function visibleContextCapacity(
    settings: ModelTurnSettings | undefined,
    _previous?: ContextMeasurement,
): number | undefined {
    return effectiveContextWindow(settings?.contextWindow, settings?.contextLimit);
}

function contextChunks(
    context: ContextMeasurement | undefined,
    settings: ModelTurnSettings | undefined,
): TuiStatusChunk[] {
    const capacity = visibleContextCapacity(settings, context);
    if (context === undefined || capacity === undefined) return [];
    const { tokens, estimated } = context;
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

export function renderTuiIdleHint(
    readyHint: string,
    runningBackgroundAgents: number,
): string {
    if (runningBackgroundAgents <= 0) {
        return readyHint;
    }
    return `waiting for ${runningBackgroundAgents} background agent${
        runningBackgroundAgents === 1 ? "" : "s"
    }`;
}

export function tuiPlaceRowModeLine(
    readyHint: string,
    idle: boolean,
    hostedControls: readonly string[] = [],
): string {
    return (idle ? [readyHint, ...hostedControls] : [...hostedControls])
        .filter((part) => part.length > 0)
        .join(" · ");
}

const COMPACTION_BAR_CELLS = 12;

const COMPACTION_BAR_HALF_LIFE_MS = 20_000;

export function renderTuiCompactionHint(
    elapsedMs: number,
    details: {
        readonly strategy?: string;
        readonly provider?: string;
        readonly model?: string;
    } = {},
): string {
    const fraction = Math.max(0, elapsedMs)
        / (Math.max(0, elapsedMs) + COMPACTION_BAR_HALF_LIFE_MS);
    const filled = Math.min(
        COMPACTION_BAR_CELLS - 1,
        Math.round(fraction * COMPACTION_BAR_CELLS),
    );
    const bar = `${"█".repeat(filled)}${
        "░".repeat(COMPACTION_BAR_CELLS - filled)
    }`;
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const model = details.model === undefined
        ? undefined
        : details.provider === undefined
        ? details.model
        : `${details.provider}/${details.model}`;
    const label = [details.strategy, model]
        .filter((part): part is string => part !== undefined)
        .join(" · ");
    return `compacting [${bar}]${label.length === 0 ? "" : ` · ${label}`}`
        + ` · ${seconds}s`;
}

function compactWorkspace(workspace: string): string {
    const home = homedir();
    return workspace === home
        ? "~"
        : workspace.startsWith(`${home}/`)
            ? `~/${workspace.slice(home.length + 1)}`
            : workspace;
}

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
