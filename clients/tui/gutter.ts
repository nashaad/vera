import {
    BoxRenderable,
    TextAttributes,
    TextRenderable,
    type CliRenderer,
    type Renderable,
} from "@opentui/core";

import {
    TUI_ELEMENT,
    TUI_MUTED,
    type TuiTranscriptEntry,
} from "./state.ts";

/** Columns the marker occupies, so wrapped content clears it. */
export const TUI_GUTTER_WIDTH = 2;

const contentNodes = new WeakMap<Renderable, Renderable>();

export interface TuiGutterAppearance {
    readonly width?: number;
    readonly separatorVisible?: boolean;
    readonly separatorColor?: string;
    readonly separatorSpacingBefore?: number;
    readonly separatorSpacingAfter?: number;
}

/** Tool rows already reserve the two columns every activity needs internally. */
export function tuiGutterWidth(
    entry: TuiTranscriptEntry,
    activityIndent: number,
): number {
    const alignedIndent = Math.max(2, activityIndent);
    return entry.kind === "tool" || entry.kind === "tool_header"
        ? alignedIndent - 2
        : alignedIndent;
}

/**
 * The marker a block opens with, and undefined for entries that draw their own
 * leading glyph. A blank marker still reserves the column so every block in the
 * transcript shares one left margin.
 */
function entryMarker(
    entry: TuiTranscriptEntry,
): {
    readonly glyph: string;
    readonly color: string;
    readonly attributes?: number;
} {
    if (
        entry.kind === "assistant"
        || entry.kind === "thought"
        || entry.kind === "thinking"
    ) {
        return {
            glyph: "•",
            color: TUI_MUTED,
            attributes: TextAttributes.BOLD,
        };
    }
    return { glyph: " ", color: TUI_MUTED };
}

/**
 * Wraps a rendered entry in the marker column. Grouping lives in this column
 * rather than in variable spacing, so every block is one blank line apart.
 */
export function createTuiGutterEntry(
    renderer: CliRenderer,
    id: string,
    entry: TuiTranscriptEntry,
    content: Renderable,
    marginTop: number,
    ruled = false,
    appearance: TuiGutterAppearance = {},
): BoxRenderable {
    const marker = entryMarker(entry);
    const width = appearance.width ?? TUI_GUTTER_WIDTH;
    const row = new BoxRenderable(renderer, {
        id: `${id}-gutter`,
        width: "100%",
        flexDirection: "row",
        marginTop: ruled ? appearance.separatorSpacingAfter ?? 1 : marginTop,
    });
    row.add(new TextRenderable(renderer, {
        id: `${id}-marker`,
        content: marker.glyph,
        fg: marker.color,
        attributes: marker.attributes,
        width,
        flexShrink: 0,
    }));
    row.add(content);
    contentNodes.set(row, content);
    if (!ruled) return row;

    // The rule marks the break, so it takes a row of its own with an empty
    // marker column rather than displacing the block's own marker.
    const column = new BoxRenderable(renderer, {
        id: `${id}-ruled`,
        width: "100%",
        flexDirection: "column",
        marginTop: appearance.separatorSpacingBefore ?? 1,
    });
    if (appearance.separatorVisible ?? true) {
        column.add(new TextRenderable(renderer, {
            id: `${id}-rule`,
            content: "─".repeat(200),
            fg: appearance.separatorColor ?? TUI_ELEMENT,
            width: "100%",
            wrapMode: "none",
            marginLeft: width,
        }));
    }
    column.add(row);
    contentNodes.set(column, content);
    return column;
}

/** The rendered entry inside a gutter row, or the node itself when bare. */
export function tuiGutterContent(node: Renderable): Renderable {
    return contentNodes.get(node) ?? node;
}
