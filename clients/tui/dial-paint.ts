/**
 * Colouring for the dial HUD. `renderDialStrip` decides what the rows say;
 * this decides how loudly each part of them says it, and nothing here touches
 * the renderer, so the whole mapping can be asserted from a test.
 */
import {
    DIAL_DEFAULT_SEPARATOR,
    DIAL_PROVIDER_SEPARATOR,
    type DialLane,
} from "./dials.ts";
import { mixHex } from "./theme.ts";

/** One run of text and the colour it is drawn in. */
export interface DialSpan {
    readonly text: string;
    readonly color: string;
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
): readonly DialSpan[] {
    const line = hudRows[index] ?? "";
    const providerParts = line.split(DIAL_PROVIDER_SEPARATOR);
    const main = providerParts[0] ?? "";
    const modelEnd = rows.modelEnd < 0 ? hudRows.length : rows.modelEnd;
    const isModelRow = rows.modelStart >= 0
        && index >= rows.modelStart
        && index < modelEnd;
    const activeRow = lane === "model"
        ? isModelRow
        : lane === "effort"
        ? rows.effort >= 0
            && index >= rows.effort - (rows.effortScaleRows > 0 ? 1 : 0)
            && index <= rows.effort + (rows.effortScaleRows > 0 ? 1 : 0)
        : lane === "agent"
        ? index === rows.agent
        : lane === "access"
        ? index === rows.access
        : false;
    const settled = (hex: string): string =>
        activeRow ? hex : mixHex(theme.background, hex, SETTLED_MIX);
    // The access modes keep their hue whether or not the lane is focused: the
    // posture the session is running under is worth reading at a glance, not
    // only while it is being changed.
    const selectedColor = (part: string): string =>
        index !== rows.access ? settled(theme.text) : settled(
            part.includes("readonly")
                ? theme.secondary
                : part.includes("ask")
                ? theme.accent
                : part.includes("auto")
                ? theme.success
                : theme.text,
        );
    const span = (text: string, color: string): DialSpan => ({ text, color });

    const isEffortScale = rows.effortScaleRows > 0
        && index >= rows.effort - 1
        && index <= rows.effort + 1;
    if (isEffortScale) {
        // The gutter chip is delimited rather than matched by text: it is the
        // one span on these rows that is not part of the axis, and it carries
        // the selection brackets when it is chosen.
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
    // The bracketed row is the one the dial is sitting on, and it reads as
    // chosen whether or not the model lane holds the focus, the same way the
    // picked agent and access cells do.
    const pickedRow = isModelRow && main.includes("[");
    const body: DialSpan[] = [];
    if (isModelRow) {
        if (index === rows.modelStart) {
            const prefixLength = laneLabel?.length ?? 2;
            body.push(
                span(
                    main.slice(0, prefixLength),
                    activeRow ? theme.text : theme.muted,
                ),
                span(
                    main.slice(prefixLength),
                    pickedRow ? settled(theme.text) : theme.muted,
                ),
            );
        } else {
            body.push(
                span(main, pickedRow ? settled(theme.text) : theme.muted),
            );
        }
    } else {
        const prefix = laneLabel ?? main.slice(0, 2);
        body.push(span(prefix, activeRow ? theme.text : theme.muted));
        for (
            const part of main.slice(prefix.length)
                .split(/(\[[^\]]+\])/)
                .filter(Boolean)
        ) {
            body.push(
                span(part, part.startsWith("[") ? selectedColor(part) : theme.muted),
            );
        }
    }
    return [
        ...body,
        // The provider is muted; anything after it is the closing bracket,
        // which belongs to the choice, not to the provider.
        ...providerParts.slice(1).map((part, at) =>
            span(
                part,
                at === 0
                    ? theme.muted
                    : pickedRow
                    ? settled(theme.text)
                    : theme.muted,
            )
        ),
    ];
}

/** Every row of the HUD, coloured. */
export function paintDialHud(
    hudRows: readonly string[],
    lane: DialLane | undefined,
    theme: DialPaintTheme,
): readonly (readonly DialSpan[])[] {
    const rows = mapDialRows(hudRows);
    return hudRows.map((_, index) =>
        paintDialRow(hudRows, index, lane, theme, rows)
    );
}
