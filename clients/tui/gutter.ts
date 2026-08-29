import {
    BoxRenderable,
    MarkdownRenderable,
    TextAttributes,
    TextRenderable,
    type CliRenderer,
    type Renderable,
} from "@opentui/core";

import {
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    type TuiTranscriptEntry,
} from "./state.ts";

/** Columns the marker occupies, so wrapped content clears it. */
export const TUI_GUTTER_WIDTH = 2;

const contentNodes = new WeakMap<Renderable, Renderable>();
/** Rows drawn with the landing marker, so a repaint does not clear it. */
const markedRows = new WeakSet<Renderable>();

export interface TuiGutterAppearance {
    readonly width?: number;
    readonly separatorVisible?: boolean;
    readonly separatorColor?: string;
    readonly separatorSpacingBefore?: number;
    readonly separatorSpacingAfter?: number;
    /** Whether this block is the one a search landed on. */
    readonly marked?: boolean;
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
function entryMarker(entry: TuiTranscriptEntry): {
    readonly glyph: string;
    readonly color: string;
    readonly attributes?: number;
} {
    if (entry.kind === "assistant") {
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
    const markerColumn = new BoxRenderable(renderer, {
        id: `${id}-marker-column`,
        width,
        flexShrink: 0,
    });
    markerColumn.add(new TextRenderable(renderer, {
        id: `${id}-marker`,
        content: marker.glyph,
        fg: marker.color,
        attributes: marker.attributes,
        width: "100%",
        flexShrink: 0,
    }));
    // A landing paints a single column down the height of the block. It sits
    // over the marker column rather than beside it, so the block's own marker
    // keeps the position it holds when nothing is marked.
    markerColumn.add(new BoxRenderable(renderer, {
        id: `${id}-marker-rule`,
        position: "absolute",
        left: 0,
        top: 0,
        width: 1,
        height: "100%",
        backgroundColor: appearance.marked === true
            ? TUI_NOTICE
            : "transparent",
    }));
    row.add(markerColumn);
    // The content must size to the space left of the marker column; at 100%
    // of the row it overhangs the right edge by the marker width and clips.
    content.width = "auto";
    content.flexGrow = 1;
    content.flexShrink = 1;
    // A markdown table lays out one column wider than the box it is given, so
    // the block keeps a column in reserve for its right border.
    if (content instanceof MarkdownRenderable) content.marginRight = 1;
    row.add(content);
    contentNodes.set(row, content);
    if (appearance.marked === true) markedRows.add(row);
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
    if (appearance.marked === true) markedRows.add(column);
    return column;
}

/**
 * Draws the landing rule on an already-built row, in place.
 *
 * In place rather than by rebuilding: the caller is about to scroll to this
 * row and a fresh node has no measured position until the next layout.
 *
 * Reports whether it found a rule to paint, so a landing that cannot be shown
 * is a failure rather than a silent no-op.
 */
export function markTuiGutterEntry(node: Renderable): boolean {
    markedRows.add(node);
    return paintGutterRule(node, TUI_NOTICE);
}

/** Clears a row's landing rule. */
export function unmarkTuiGutterEntry(
    node: Renderable,
    _entry: TuiTranscriptEntry,
): void {
    markedRows.delete(node);
    paintGutterRule(node, "transparent");
}

function paintGutterRule(node: Renderable, color: string): boolean {
    let found = false;
    const paint = (current: Renderable): void => {
        if (current instanceof BoxRenderable
            && current.id.endsWith("-marker-rule")) {
            current.backgroundColor = color;
            found = true;
        }
        for (const child of current.getChildren()) paint(child);
    };
    paint(node);
    return found;
}

/** The rendered entry inside a gutter row, or the node itself when bare. */
export function tuiGutterContent(node: Renderable): Renderable {
    return contentNodes.get(node) ?? node;
}

/** Repaints the chrome around a caller-owned entry without replacing its node. */
export function repaintTuiGutterEntry(
    node: Renderable,
    appearance: TuiGutterAppearance = {},
): void {
    const marked = markedRows.has(node);
    const repaint = (current: Renderable): void => {
        if (current instanceof BoxRenderable
            && current.id.endsWith("-marker-rule")) {
            current.backgroundColor = marked ? TUI_NOTICE : "transparent";
        }
        if (current instanceof TextRenderable) {
            if (current.id.endsWith("-marker")) {
                current.fg = TUI_MUTED;
            } else if (current.id.endsWith("-rule")) {
                current.fg = appearance.separatorColor ?? TUI_ELEMENT;
            }
        }
        for (const child of current.getChildren()) repaint(child);
    };
    repaint(node);
}
