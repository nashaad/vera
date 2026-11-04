import { BoxRenderable, Renderable, RGBA, TextRenderable } from "@opentui/core";
import type { CliRenderer, OptimizedBuffer } from "@opentui/core";

import { tuiBrailleSpinner } from "./activity-pulse.ts";
import type { TuiTextTranscriptEntry } from "./state.ts";
import type { TuiLiveReasoningRows } from "./theme-preference.ts";
import {
    LIVE_THINKING_ELLIPSIS,
    plainReasoningSummary,
    TUI_MUTED,
} from "./state.ts";

// Enough text to fill the widest pane at the most rows; older text is cut first.
const TAIL_CHARACTERS = 4_000;
export const ELLIPSIS_COLUMNS = LIVE_THINKING_ELLIPSIS.length + 1;
export const RAIL = "│";

interface ThinkingWindowParts {
    readonly gutter: ThinkingGutterRenderable;
    readonly body: TailTextRenderable;
    readonly reasoning: LiveReasoningCache;
}

const windowParts = new WeakMap<BoxRenderable, ThinkingWindowParts>();

// Draws the last rows of its wrapped text instead of the first.
class TailTextRenderable extends TextRenderable {
    private rendered = "";
    private manual = false;

    // Re-setting the whole text costs more than linear time as it grows; appending
    // the new suffix keeps a streaming delta flat.
    setTailText(text: string): void {
        if (text === this.rendered) return;
        const previous = this.rendered;
        this.rendered = text;
        if (!this.manual) {
            // The first non-empty text marks the renderable manual; TextNode passes
            // would otherwise clear the buffer the appends built.
            if (text !== "") {
                this.content = text;
                this.manual = true;
            }
            return;
        }
        if (text.startsWith(previous)) {
            this.textBuffer.append(text.slice(previous.length));
        } else {
            this.textBuffer.setText(text);
        }
        this.updateTextInfo();
    }

    protected override renderSelf(
        buffer: Parameters<TextRenderable["renderSelf"]>[0],
    ): void {
        const bottom = this.maxScrollY;
        if (this._scrollY !== bottom) {
            this._scrollY = bottom;
            this.updateViewportOffset();
        }
        super.renderSelf(buffer);
    }
}

// One rail per shown row, with the mark on the newest; wrapped rows count as rows.
class ThinkingGutterRenderable extends Renderable {
    mark = LIVE_THINKING_ELLIPSIS;

    constructor(renderer: CliRenderer, id: string, private readonly body: TailTextRenderable) {
        super(renderer, { id, width: ELLIPSIS_COLUMNS, flexShrink: 0 });
    }

    protected override renderSelf(buffer: OptimizedBuffer): void {
        const color = RGBA.fromHex(TUI_MUTED);
        const rows = this.body.visible
            ? Math.max(1, Math.min(this.body.virtualLineCount, this.body.height))
            : 1;
        for (let row = 0; row < rows - 1; row++) {
            buffer.drawText(RAIL, this.x, this.y + row, color);
        }
        buffer.drawText(this.mark, this.x, this.y + rows - 1, color);
    }
}

export function liveReasoningHeight(rows: Exclude<TuiLiveReasoningRows, "all">): number {
    return Math.max(1, rows);
}

export function createTuiThinkingWindow(
    renderer: CliRenderer,
    id: string,
    entry: TuiTextTranscriptEntry,
    marginTop: number,
    rows: TuiLiveReasoningRows,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        marginTop,
    });
    const body = new TailTextRenderable(renderer, {
        id: `${id}-body`,
        fg: TUI_MUTED,
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        wrapMode: "word",
        overflow: "hidden",
        selectable: true,
    });
    const gutter = new ThinkingGutterRenderable(renderer, `${id}-gutter`, body);
    box.add(gutter);
    box.add(body);
    windowParts.set(box, { gutter, body, reasoning: createLiveReasoningCache() });
    updateTuiThinkingWindow(box, entry, rows);
    return box;
}

export function updateTuiThinkingWindow(
    node: BoxRenderable,
    entry: TuiTextTranscriptEntry,
    rows: TuiLiveReasoningRows,
): void {
    const parts = windowParts.get(node);
    if (parts === undefined) return;
    const height = rows === "all" ? "auto" : liveReasoningHeight(rows);
    node.height = height;
    parts.body.height = height;
    parts.body.visible = rows !== 0;
    parts.body.setTailText(rows === 0
        ? ""
        : liveReasoningText(entry.text, rows === "all", parts.reasoning));
}

// The mark is padded to the ellipsis width so the reasoning text never shifts.
export function animateTuiThinkingWindow(node: BoxRenderable, frame: number): void {
    const parts = windowParts.get(node);
    if (parts === undefined) return;
    parts.gutter.mark = tuiBrailleSpinner(frame).padEnd(LIVE_THINKING_ELLIPSIS.length);
    parts.gutter.requestRender();
}

export function liveReasoningText(
    text: string,
    whole: boolean,
    cache?: LiveReasoningCache,
): string {
    if (whole && cache !== undefined) {
        updateReasoningCache(cache, text);
        return cache.rendered;
    }
    return wholeReasoningText(whole ? text : text.slice(-TAIL_CHARACTERS));
}

// Rows of the cached rendering, matching transcriptEstimatedRows over liveReasoningText.
export function liveReasoningRowCount(
    cache: LiveReasoningCache,
    text: string,
    width: number,
): number {
    updateReasoningCache(cache, text);
    if (cache.rowsWidth !== width) {
        cache.rowsWidth = width;
        cache.bodyRows = cache.opaque
            ? cache.rendered
                .split("\n")
                .reduce((rows, line) => rows + estimatedLineRows(line, width), 0)
            : cache.lines.reduce(
                (rows, line) => rows + estimatedLineRows(line, width),
                0,
            );
        cache.tailRows = cache.opaque || cache.tailText.length === 0
            ? 0
            : estimatedLineRows(cache.tailText, width);
    }
    const rows = cache.bodyRows + cache.tailRows;
    return rows === 0 ? 1 : rows;
}

/** Incremental state behind one live reasoning block; append-only while text grows. */
export interface LiveReasoningCache {
    source: string;
    lines: string[];
    body: string;
    lineCount: number;
    tail: string;
    tailText: string;
    rendered: string;
    bodyRows: number;
    tailRows: number;
    rowsWidth: number;
    opaque: boolean;
}

export function createLiveReasoningCache(): LiveReasoningCache {
    return {
        source: "",
        lines: [],
        body: "",
        lineCount: 0,
        tail: "",
        tailText: "",
        rendered: "",
        bodyRows: 0,
        tailRows: 0,
        rowsWidth: -1,
        opaque: false,
    };
}

const SEPARATOR_LINE = /^[ \t]*[-=]{3,}[ \t]*$/;
const HEADING_LINE = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]+#*[ \t]*$/;
const BOLD_LINE = /^[ \t]*(?:\*\*|__)(.*?)(?:\*\*|__)[ \t]*$/;
// The whole-text regexes treat these as line boundaries but split("\n") does not.
const OPAQUE_LINE_BREAK = /[\r\u2028\u2029]/;

function wholeReasoningText(text: string): string {
    return plainReasoningSummary(text)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .join("\n");
}

function plainReasoningLine(line: string): string {
    return line
        .replace(HEADING_LINE, "$1")
        .replace(BOLD_LINE, "$1")
        .trimEnd();
}

function estimatedLineRows(line: string, width: number): number {
    const length = Math.max(1, Array.from(line).length);
    return Math.max(1, Math.ceil(length / Math.max(1, width)));
}

export function updateReasoningCache(cache: LiveReasoningCache, source: string): void {
    if (source === cache.source) return;
    if (cache.opaque) {
        if (source.startsWith(cache.source)) {
            setOpaqueReasoningText(cache, source);
            return;
        }
        resetReasoningCache(cache);
    }
    if (OPAQUE_LINE_BREAK.test(source)) {
        setOpaqueReasoningText(cache, source);
        return;
    }
    if (!source.startsWith(cache.source)) resetReasoningCache(cache);
    const pieces = (cache.tail + source.slice(cache.source.length)).split("\n");
    cache.tail = pieces.pop() ?? "";
    for (const piece of pieces) appendReasoningLine(cache, piece);
    cache.source = source;
    renderReasoningCache(cache);
}

function appendReasoningLine(cache: LiveReasoningCache, line: string): void {
    // A separator line loses the newline before it, which the empty-line filter
    // would drop anyway; the first line has no newline before it.
    const separator = cache.lineCount > 0 && SEPARATOR_LINE.test(line);
    cache.lineCount += 1;
    if (separator) return;
    const processed = plainReasoningLine(line);
    if (processed.length === 0) return;
    cache.lines.push(processed);
    if (cache.rowsWidth >= 0) {
        cache.bodyRows += estimatedLineRows(processed, cache.rowsWidth);
    }
}

function renderReasoningCache(cache: LiveReasoningCache): void {
    // A deep cons chain from incremental appends costs the native text buffer far
    // more to flatten than one join, so materialize the body on each change.
    cache.body = cache.lines.join("\n");
    const tail = cache.lineCount > 0 && SEPARATOR_LINE.test(cache.tail)
        ? ""
        : plainReasoningLine(cache.tail);
    cache.tailText = tail;
    cache.rendered = tail.length === 0
        ? cache.body
        : cache.body.length === 0
        ? tail
        : `${cache.body}\n${tail}`;
    if (cache.rowsWidth >= 0) {
        cache.tailRows = tail.length === 0
            ? 0
            : estimatedLineRows(tail, cache.rowsWidth);
    }
}

function resetReasoningCache(cache: LiveReasoningCache): void {
    cache.source = "";
    cache.lines = [];
    cache.body = "";
    cache.lineCount = 0;
    cache.tail = "";
    cache.tailText = "";
    cache.rendered = "";
    cache.bodyRows = 0;
    cache.tailRows = 0;
    cache.rowsWidth = -1;
    cache.opaque = false;
}

function setOpaqueReasoningText(cache: LiveReasoningCache, source: string): void {
    resetReasoningCache(cache);
    cache.opaque = true;
    cache.source = source;
    cache.rendered = wholeReasoningText(source);
}
