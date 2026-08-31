/**
 * Colouring for the dial HUD. `renderDialStrip` decides what the rows say;
 * this decides how loudly each part of them says it, and nothing here touches
 * the renderer, so the whole mapping can be asserted from a test.
 */
import {
    DIAL_DEFAULT_SEPARATOR,
    DIAL_PICK_MARKER,
    DIAL_PROVIDER_SEPARATOR,
    type DialLane,
} from "./dials.ts";
import { mixHex } from "./theme.ts";

/** One run of text and the colour it is drawn in. */
export interface DialSpan {
    readonly text: string;
    readonly color: string;
    readonly background?: string;
}

/** The colours the HUD draws with, resolved from the live theme. */
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

/** Where each rung's row sits, and how tall the effort block is. */
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

/**
 * How far an unfocused rung's chosen value is pulled toward the background.
 * Far enough to stop competing with the focused rung, near enough to still
 * read what the session is set to.
 */
const SETTLED_MIX = 0.45;

/** Every rung's label, in a shape a row can be tested against. */
const LANE_LABELS = ["MODEL", "EFFORT", "AGENT", "ACCESS"] as const;

/**
 * Finds each rung by its label. Row positions are not counted from a fixed
 * offset because the model list is variable height and the effort scale adds
 * rows only when it is wide enough to draw. The focus marker is stripped
 * before the label is read, so a focused row still matches its own lane.
 */
export function mapDialRows(hudRows: readonly string[]): DialRowMap {
    const rowIndex = (label: string): number =>
        hudRows.findIndex((line) =>
            line.replace(/^[› ]\s*/, "").startsWith(label)
        );
    const effort = hudRows.findIndex((line) => line.includes("EFFORT"));
    // The scale puts its axis labels on the row above EFFORT and the option
    // labels below it, so the lane sits in the middle of its own block.
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
        // The model rung runs from its label to whatever rung is drawn next.
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

/**
 * Colours one HUD row. Three weights, not two: the rung under the cursor is
 * brightest, a chosen value on a rung the cursor is elsewhere sits between,
 * and everything unchosen is muted. With only two weights every rung's current
 * value shouts as loudly as the one being changed.
 */
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
        || (lane === "effort" || state.effortPending === true) && isEffortRow
        || lane === "agent" && index === rows.agent
        || lane === "access" && index === rows.access
        ? true
        : false;
    const settled = (hex: string): string =>
        activeRow ? hex : mixHex(theme.background, hex, SETTLED_MIX);
    // The access modes keep their hue whether or not the lane is focused: the
    // posture the session is running under is worth reading at a glance, not
    // only while it is being changed.
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
        // The gutter chip is delimited rather than matched by text: it is the
        // one span on these rows that is not part of the axis, and it carries
        // the pick mark when it is chosen.
        const parts = main.split(DIAL_DEFAULT_SEPARATOR);
        const axis = parts.length > 1 ? parts.pop() ?? "" : main;
        // Odd spans are the gutter marks, even spans the plain text between
        // them. The gutter carries the same colour as the labels under the
        // track, except the resolved-default note, which is a footnote, and
        // the marker, which is a selection.
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

    // Only the lane holding the focus is lit, name included, so the eye lands
    // on one rung instead of reading four equally bright ones.
    const laneLabel = main.match(/^[› ] (?:MODEL|EFFORT|AGENT|ACCESS)\s*/)?.[0];
    // The marked row is the one the dial is sitting on, and it reads as chosen
    // whether or not the model lane holds the focus, the same way the picked
    // agent and access cells do.
    const pickedRow = isModelRow && main.includes(DIAL_PICK_MARKER, 2);
    // Once focus leaves the model lane, its pick settles back to plain text:
    // still the chosen row, no longer the row being chosen.
    const cursorColor = activeRow ? theme.accent : settled(theme.text);
    const body: DialSpan[] = [];
    if (isModelRow) {
        const selected = pickedRow && lane === "model";
        if (selected) {
            // The source mark remains outside the selection bar, like the
            // shortlist dot in the model picker. The bar begins at the pick
            // mark and runs through the padded model/provider cell.
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
        // A picked cell runs from its mark to the space before the next cell.
        for (
            const part of main.slice(prefix.length)
                .split(new RegExp(`(${DIAL_PICK_MARKER}[^ ]+(?: [^ ›]+)*)`, "u"))
                .filter(Boolean)
        ) {
            const picked = part.startsWith(DIAL_PICK_MARKER);
            const highlightedAccess = picked
                && index === rows.access
                && lane === "access";
            body.push(
                span(
                    part,
                    highlightedAccess
                        ? theme.background
                        : picked
                        ? selectedColor(part)
                        : theme.muted,
                    highlightedAccess ? accessHue(part) : undefined,
                ),
            );
        }
    }
    return [
        ...body,
        // The provider is muted; anything after it belongs to the choice, not to
        // the provider.
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

/** A narrow green tracer that travels down the HUD's far-right edge. */
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
    // Fractional travel lets each cell brighten between positions instead of
    // making the terminal-sized trail jump one whole row at a time.
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

/** Every row of the HUD, coloured. */
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
