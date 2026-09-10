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
    const effortScaleRows = effort >= 1
            && hudRows[effort - 1]?.includes("Faster") === true
        ? 2
        : 0;
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
    const providerParts = line.split(DIAL_PROVIDER_SEPARATOR);
    const main = providerParts[0] ?? "";
    const modelEnd = rows.modelEnd < 0 ? hudRows.length : rows.modelEnd;
    const isModelRow = rows.modelStart >= 0
        && index >= rows.modelStart
        && index < modelEnd;
    const isEffortRow = rows.effort >= 0
        && index >= rows.effort - (rows.effortScaleRows > 0 ? 1 : 0)
        && index <= rows.effort + (rows.effortScaleRows > 0 ? 1 : 0);
    const activeRow = lane === "model" && isModelRow
        || lane === "effort" && isEffortRow
        || lane === "agent" && index === rows.agent
        || lane === "access" && index === rows.access
        ? true
        : false;
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

    const isEffortScale = rows.effortScaleRows > 0
        && index >= rows.effort - 1
        && index <= rows.effort + 1;
    if (isEffortScale) {
        const parts = main.split(DIAL_DEFAULT_SEPARATOR);
        const axis = parts.length > 1 ? parts.pop() ?? "" : main;
        const gutter = parts.length > 1
            ? parts.map((part, at) =>
                span(
                    part,
                    at % 2 === 0
                        ? activeRow ? theme.text : theme.muted
                        : part === "▲"
                        ? settled(theme.notice)
                        : part.startsWith("(") || !activeRow
                        ? theme.muted
                        : theme.accent,
                )
            )
            : [];
        return [
            ...gutter,
            ...(index === rows.effort - 1
                ? [span(axis, activeRow ? theme.accent : theme.muted)]
                : axis.split(/(▲|·+)/u).filter(Boolean).map((part) =>
                    span(
                        part,
                        part === "▲"
                            ? settled(theme.notice)
                            : part.startsWith("·") || !activeRow
                            ? theme.muted
                            : theme.accent,
                    )
                )),
        ];
    }

    const laneLabel = main.match(/^[› ] (?:MODEL|EFFORT|AGENT|ACCESS)\s*/)?.[0];
    if (isModelRow && /(?:Recent|From Model Library)$/.test(main)) {
        return [span(laneLabel ?? "", activeRow ? theme.text : theme.muted),
            span(main.slice(laneLabel?.length ?? 0), activeRow ? theme.accent : theme.muted)];
    }
    const pickedRow = isModelRow && main.includes(DIAL_PICK_MARKER, 2);
    const cursorColor = activeRow ? theme.accent : settled(theme.text);
    const body: DialSpan[] = [];
    if (isModelRow) {
        const selected = pickedRow && lane === "model";
        if (selected) {
            const pickAt = main.indexOf(DIAL_PICK_MARKER, 2);
            const prefixLength = pickAt < 0 ? 0 : pickAt;
            body.push(
                span(
                    main.slice(0, prefixLength),
                    index === rows.modelStart ? theme.text : theme.muted,
                ),
                span(
                    main.slice(prefixLength),
                    theme.background,
                    theme.accent,
                ),
            );
        } else if (index === rows.modelStart) {
            const prefixLength = laneLabel?.length ?? 2;
            body.push(
                span(
                    main.slice(0, prefixLength),
                    activeRow ? theme.text : theme.muted,
                ),
                span(
                    main.slice(prefixLength),
                    pickedRow ? cursorColor : theme.muted,
                ),
            );
        } else {
            body.push(span(main, pickedRow ? cursorColor : theme.muted));
        }
    } else {
        const prefix = laneLabel ?? main.slice(0, 2);
        body.push(span(prefix, activeRow ? theme.text : theme.muted));
        for (
            const part of main.slice(prefix.length)
                .split(new RegExp(`(${DIAL_PICK_MARKER}[^ ]+(?: [^ ›]+)*)`, "u"))
                .filter(Boolean)
        ) {
            const picked = part.startsWith(DIAL_PICK_MARKER);
            const highlightedChoice = picked && activeRow;
            body.push(
                span(
                    index === rows.agent && picked ? part.replace(DIAL_PICK_MARKER, " ") : part,
                    highlightedChoice
                        ? theme.background
                        : picked
                        ? selectedColor(part)
                        : theme.muted,
                    highlightedChoice ? index === rows.access ? accessHue(part) : theme.accent : undefined,
                ),
            );
        }
    }
    return [
        ...body,
        ...providerParts.slice(1).map((part, at) =>
            span(
                part,
                at === 0
                    ? selectedModelColor(pickedRow, lane, theme)
                    : pickedRow
                    ? cursorColor
                    : theme.muted,
                pickedRow && lane === "model" ? theme.accent : undefined,
            )
        ),
    ];
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
