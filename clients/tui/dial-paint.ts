import {
    DIAL_DEFAULT_SEPARATOR,
    DIAL_PICK_MARKER,
    DIAL_PROVIDER_SEPARATOR,
    type DialLane,
} from "./dials.ts";
import { mixHex } from "./theme.ts";

export interface DialSpan {
    readonly text: string;
    readonly color: string;
    readonly background?: string;
}

export interface DialPaintTheme {
    readonly text: string;
    readonly muted: string;
    readonly accent: string;
    readonly notice: string;
    readonly background: string;
    readonly success: string;
    readonly secondary: string;
    readonly accessAsk: string;
    readonly accessAuto: string;
}

export interface DialRowMap {
    readonly effort: number;
    readonly effortScaleRows: number;
    readonly access: number;
    readonly modelStart: number;
    readonly modelEnd: number;
    readonly agent: number;
}

export interface DialPaintState {
    readonly effortPending?: boolean;
    readonly autoAnimation?: {
        readonly progress: number;
        readonly width: number;
    };
}

export const AUTO_MODE_ANIMATION_DURATION_MS = 1_450;

const SETTLED_MIX = 0.45;

const LANE_LABELS = ["MODEL", "EFFORT", "AGENT", "ACCESS"] as const;

export function mapDialRows(hudRows: readonly string[]): DialRowMap {
    const rowIndex = (label: string): number =>
        hudRows.findIndex((line) =>
            line.replace(/^[› ]\s*/, "").startsWith(label)
        );
    const effort = hudRows.findIndex((line) => line.includes("EFFORT"));
    const effortScaleRows = effort >= 0 && hudRows[effort + 1]?.includes("Faster") === true ? 3 : 0;
    const agent = rowIndex("AGENT");
    const modelStart = rowIndex("MODEL");
    return {
        effort,
        effortScaleRows,
        access: rowIndex("ACCESS"),
        modelStart,
        modelEnd: modelStart < 0
            ? -1
            : hudRows.findIndex((line, at) =>
                at > modelStart
                && LANE_LABELS.some((label) =>
                    line.replace(/^[› ]\s*/, "").startsWith(label)
                )
            ),
        agent,
    };
}

export function paintDialRow(
    hudRows: readonly string[],
    index: number,
    lane: DialLane | undefined,
    theme: DialPaintTheme,
    rows: DialRowMap = mapDialRows(hudRows),
    state: DialPaintState = {},
): readonly DialSpan[] {
    const line = hudRows[index] ?? "";
    if (rows.effortScaleRows > 0 && index > rows.effort && index <= rows.effort + rows.effortScaleRows) {
        return line.split(/(▲)/u).filter(Boolean).map((text) => ({ text,
            color: text === "▲" ? lane === "effort" ? theme.accent : theme.text : theme.muted }));
    }
    const modelRow = rows.modelStart >= 0 && index >= rows.modelStart && index < rows.modelEnd;
    const active = modelRow ? lane === "model" : line.startsWith("› ");
    const prefix = line.match(/^[› ] (?:EFFORT|ACCESS|MODEL|AGENT)\s*/)?.[0] ?? "";
    const spans: DialSpan[] = [{ text: prefix, color: active ? theme.text : theme.muted }];
    for (const text of line.slice(prefix.length).split(/(‹ .*? ›)/u).filter(Boolean)) {
        const picked = text.startsWith("‹ ");
        const hue = index !== rows.access ? theme.text
            : text.includes("readonly") ? theme.secondary
            : text.includes("ask") ? theme.accessAsk
            : text.includes("auto") ? theme.accessAuto : theme.text;
        spans.push({ text,
            color: picked ? active ? theme.background : mixHex(theme.background, hue, SETTLED_MIX)
                : theme.muted,
            ...(picked && active ? { background: index === rows.access ? hue : theme.accent } : {}),
        });
    }
    return spans;
}

export function autoModeEdgeIntensity(
    progress: number,
    row: number,
    rowCount: number,
): number {
    if (
        !Number.isFinite(progress)
        || !Number.isFinite(row)
        || !Number.isFinite(rowCount)
        || row < 0
        || rowCount <= 0
        || row >= rowCount
    ) return 0;
    const bounded = Math.max(0, Math.min(1, progress));
    const rows = Math.max(1, rowCount);
    const trailRows = Math.min(7, Math.max(4, Math.ceil(rows / 4)));
    const sweepProgress = easeInOutCubic(Math.min(1, bounded / 0.88));
    const head = sweepProgress * (rows + trailRows * 2) - trailRows;
    const distance = head - row;
    if (distance < 0 || distance >= trailRows) return 0;
    const fade = bounded <= 0.9
        ? 1
        : Math.max(0, 1 - (bounded - 0.9) / 0.1);
    return Math.sin((1 - distance / trailRows) * Math.PI / 2) ** 2
        * 0.92
        * fade;
}

function easeInOutCubic(value: number): number {
    return value < 0.5
        ? 4 * value ** 3
        : 1 - (-2 * value + 2) ** 3 / 2;
}

function selectedModelColor(
    picked: boolean,
    lane: DialLane | undefined,
    theme: DialPaintTheme,
): string {
    return picked && lane === "model" ? theme.background : theme.muted;
}

export function paintDialHud(
    hudRows: readonly string[],
    lane: DialLane | undefined,
    theme: DialPaintTheme,
    state: DialPaintState = {},
): readonly (readonly DialSpan[])[] {
    const rows = mapDialRows(hudRows);
    const painted = hudRows.map((_, index) =>
        paintDialRow(hudRows, index, lane, theme, rows, state)
    );
    const animation = state.autoAnimation;
    if (animation === undefined) return painted;
    const animationWidth = Number.isFinite(animation.width)
        ? Math.max(0, Math.floor(animation.width))
        : 0;
    if (animationWidth === 0) return painted;
    return painted.map((spans, index) => {
        const intensity = autoModeEdgeIntensity(
            animation.progress,
            index,
            painted.length,
        );
        if (intensity <= 0) return spans;
        const visibleWidth = spans.reduce(
            (total, span) => total + span.text.length,
            0,
        );
        const edgeWidth = Math.min(
            2,
            Math.max(0, animationWidth - visibleWidth),
        );
        if (edgeWidth === 0) return spans;
        const padding = Math.max(
            0,
            animationWidth - visibleWidth - edgeWidth,
        );
        return [
            ...spans,
            ...(padding === 0
                ? []
                : [{ text: " ".repeat(padding), color: theme.background }]),
            ...(edgeWidth === 1
                ? []
                : [{
                    text: " ",
                    color: theme.background,
                    background: mixHex(
                        theme.background,
                        theme.accessAuto,
                        intensity * 0.42,
                    ),
                }]),
            {
                text: " ",
                color: theme.background,
                background: mixHex(
                    theme.background,
                    theme.accessAuto,
                    intensity,
                ),
            },
        ];
    });
}
