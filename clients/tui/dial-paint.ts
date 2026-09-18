import { DIAL_PICK_MARKER, type DialLane } from "./dials.ts";
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
    readonly agent: number;
    readonly access: number;
}

export interface DialPaintState {
    readonly autoAnimation?: {
        readonly progress: number;
        readonly width: number;
    };
}

export const AUTO_MODE_ANIMATION_DURATION_MS = 1_450;

const SETTLED_MIX = 0.45;

export function mapDialRows(hudRows: readonly string[]): DialRowMap {
    const rowIndex = (label: string): number =>
        hudRows.findIndex((line) =>
            line.replace(/^[› ]\s*/, "").startsWith(label)
        );
    return {
        agent: rowIndex("AGENT"),
        access: rowIndex("ACCESS"),
    };
}

export function paintDialRow(
    hudRows: readonly string[],
    index: number,
    lane: DialLane | undefined,
    theme: DialPaintTheme,
    rows: DialRowMap = mapDialRows(hudRows),
): readonly DialSpan[] {
    const main = hudRows[index] ?? "";
    const activeRow = lane === "agent" && index === rows.agent
        || lane === "access" && index === rows.access;
    const settled = (hex: string): string =>
        activeRow ? hex : mixHex(theme.background, hex, SETTLED_MIX);
    const accessHue = (part: string): string =>
        part.includes("readonly")
            ? theme.secondary
            : part.includes("ask")
            ? theme.accessAsk
            : part.includes("auto")
            ? theme.accessAuto
            : theme.text;
    const selectedColor = (part: string): string =>
        index !== rows.access
            ? settled(theme.text)
            : settled(accessHue(part));
    const span = (
        text: string,
        color: string,
        background?: string,
    ): DialSpan => ({
        text,
        color,
        ...(background === undefined ? {} : { background }),
    });

    const laneLabel = main.match(/^[› ] (?:AGENT|ACCESS)\s*/)?.[0];
    const prefix = laneLabel ?? main.slice(0, 2);
    const body: DialSpan[] = [
        span(prefix, activeRow ? theme.text : theme.muted),
    ];
    for (
        const part of main.slice(prefix.length)
            .split(new RegExp(`(${DIAL_PICK_MARKER}[^ ]+(?: [^ ›]+)* ?)`, "u"))
            .filter(Boolean)
    ) {
        const picked = part.startsWith(DIAL_PICK_MARKER);
        const highlightedChoice = picked && activeRow;
        body.push(
            span(
                picked ? part.replace(DIAL_PICK_MARKER, " ") : part,
                highlightedChoice
                    ? theme.background
                    : picked
                    ? selectedColor(part)
                    : theme.muted,
                highlightedChoice ? index === rows.access ? accessHue(part) : theme.accent : undefined,
            ),
        );
    }
    return body;
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

export function paintDialHud(
    hudRows: readonly string[],
    lane: DialLane | undefined,
    theme: DialPaintTheme,
    state: DialPaintState = {},
): readonly (readonly DialSpan[])[] {
    const rows = mapDialRows(hudRows);
    const painted = hudRows.map((_, index) =>
        paintDialRow(hudRows, index, lane, theme, rows)
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
