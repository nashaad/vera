import { tuiWorkedDividerView, updateTuiWorkedDivider } from "../worked-divider.ts";
import { tuiGutterContent, tuiGutterWidth } from "../gutter.ts";
import { assistantFollowsTools, reseedTranscriptNodes } from "../main.ts";
import { createTuiEntryNode, mainTranscriptWidth } from "../main/sidebar-pane.ts";
import { tuiMarkdownEntryContent } from "../markdown-entry.ts";
import { updateTuiNoticeCard } from "../notice-card.ts";
import { updateTuiErrorRow } from "../error-row.ts";
import { updateTuiReasoningBlock } from "../reasoning-block.ts";
import { renderTuiEntry, tuiEntryIsErrorRow, tuiEntryMarginTop, type TuiTranscriptEntry } from "../state.ts";
import { animateTuiThinkingWindow, createLiveReasoningCache, ELLIPSIS_COLUMNS, liveReasoningHeight, liveReasoningRowCount, updateTuiThinkingWindow } from "../thinking-window.ts";
import { saveTuiTipState } from "../tips-store.ts";
import { TUI_TIPS, recordTuiTipShown, selectTuiTip, type TuiTip, type TuiTipContext } from "../tips.ts";
import { animateTuiToolHeader, updateTuiToolHeader, updateTuiToolRow } from "../tool-row.ts";
import { setTextContent } from "../text-content.ts";
import { resumeTuiTranscriptFollow, tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import { TUI_TRANSCRIPT_INITIAL_WINDOW, TUI_TRANSCRIPT_MATERIALIZE_BATCH, TUI_TRANSCRIPT_MATERIALIZE_BUFFER, tuiTranscriptEntryIsVisible, tuiTranscriptEntryStreams, tuiTranscriptEvictableRows, tuiTranscriptNeedsEarlierEntries, tuiTranscriptPrependRange, tuiTranscriptTailRange } from "../transcript-window.ts";
import type { TuiRuntime, TuiTranscriptSourceAnchor } from "./runtime.ts";
import { BoxRenderable, MarkdownRenderable, TextBufferRenderable, TextRenderable, TextTableRenderable, type Renderable } from "@opentui/core";

export function tipContext(rt: TuiRuntime, inModelPicker: boolean): TuiTipContext {
    const pooled = rt.state.modelSettings?.pooled ?? [];
    return {
        launches: rt.tipState.launches,
        pooledCount: pooled.length,
        namedPoolCount: pooled.filter((entry) =>
            entry.poolName !== undefined
        ).length,
        anyVerified: pooled.some((entry) => entry.verified),
        inModelPicker,
    };
}

export function tipPool(rt: TuiRuntime): readonly TuiTip[] {
    const registered = rt.clientExtensionRegistry?.tips() ?? [];
    if (registered.length === 0) return TUI_TIPS;
    return [
        ...TUI_TIPS,
        ...registered.map((descriptor) => ({
            id: descriptor.id,
            text: () => descriptor.text,
            cooldownLaunches: descriptor.cooldownLaunches,
            isRelevant: (context: TuiTipContext) =>
                descriptor.isRelevant(context),
        })),
    ];
}

export function takeTip(rt: TuiRuntime, inModelPicker: boolean): string | undefined {
    if (!rt.tipsEnabled) return undefined;
    const tip = selectTuiTip(
        tipContext(rt, inModelPicker),
        rt.tipState.history,
        tipPool(rt),
    );
    if (tip === undefined) return undefined;
    rt.tipState = {
        launches: rt.tipState.launches,
        history: recordTuiTipShown(
            tip.id,
            rt.tipState.history,
            rt.tipState.launches,
        ),
    };
    saveTuiTipState(rt.tipState);
    return tip.text(tipContext(rt, inModelPicker));
}

export function transcriptEntryText(rt: TuiRuntime, entry: TuiTranscriptEntry): string {
    if (entry.kind === "diff") return `${entry.path}\n${entry.patch}`;
    return entry.suffix === undefined ? entry.text : `${entry.text} · ${entry.suffix}`;
}

export function transcriptEstimatedRows(rt: TuiRuntime, text: string, width: number): number {
    return text.split("\n").reduce((rows, line) => {
        const length = Math.max(1, Array.from(line).length);
        return rows + Math.max(1, Math.ceil(length / Math.max(1, width)));
    }, 0);
}

export function invalidateMeasuredEntryRows(rt: TuiRuntime): void {
    const width = mainTranscriptWidth(rt);
    if (width === rt.measuredEntryRowsWidth) return;
    rt.measuredEntryRowsWidth = width;
    rt.measuredEntryRows.length = 0;
}

export function measureTranscriptEntryNode(rt: TuiRuntime, index: number): void {
    const node = rt.entryNodes[index];
    if (node === undefined) return;
    const margin = node.marginTop;
    const rows = node.height + (typeof margin === "number" ? margin : 0);
    if (rows > 0) rt.measuredEntryRows[index] = rows;
}

export function measureMaterializedTranscriptEntries(rt: TuiRuntime): void {
    invalidateMeasuredEntryRows(rt);
    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        measureTranscriptEntryNode(rt, index);
    }
}

export function transcriptEntryRows(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    index: number,
): number {
    if (!tuiTranscriptEntryIsVisible(entries[index])) return 0;
    return rt.measuredEntryRows[index] ?? estimateTranscriptEntryRows(rt, 
        entries,
        index,
    );
}

// Keyed by entry object: a delta replaces only the entry it changes, so the spacer estimate for the rest is reused.
const estimatedRowsMemo = new WeakMap<TuiTranscriptEntry, {
    readonly width: number;
    readonly margin: number;
    readonly rows: number;
}>();

export function estimateTranscriptEntryRows(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    index: number,
): number {
    const entry = entries[index];
    if (entry === undefined) return 0;
    if (!tuiTranscriptEntryIsVisible(entry)) return 0;
    const width = Math.max(
        8,
        mainTranscriptWidth(rt)
            - tuiGutterWidth(entry, rt.appearance.activityIndent)
            - 1,
    );
    const margin = tuiEntryMarginTop(entries, index, rt.entrySpacing);
    if (entry.kind !== "thinking") {
        const known = estimatedRowsMemo.get(entry);
        if (known !== undefined && known.width === width && known.margin === margin) {
            return known.rows;
        }
        const rows = margin + Math.max(
            1,
            transcriptEstimatedRows(rt, transcriptEntryText(rt, entry), width),
        );
        estimatedRowsMemo.set(entry, { width, margin, rows });
        return rows;
    }
    if (rt.liveReasoningRows !== "all") return margin + liveReasoningHeight(rt.liveReasoningRows);
    let cache = rt.reasoningRowCaches?.get(index);
    if (cache === undefined) {
        if (rt.reasoningRowCaches === undefined) {
            rt.reasoningRowCaches = new Map();
        }
        cache = createLiveReasoningCache();
        rt.reasoningRowCaches.set(index, cache);
    }
    return margin + liveReasoningRowCount(
        cache,
        entry.text,
        Math.max(8, width - ELLIPSIS_COLUMNS),
    );
}

export function estimatedTranscriptRows(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    start: number,
    end: number,
): number {
    invalidateMeasuredEntryRows(rt);
    let rows = 0;
    for (let index = Math.max(0, start); index < end; index += 1) {
        rows += transcriptEntryRows(rt, entries, index);
    }
    return rows;
}

export function animateLiveToolHeaders(rt: TuiRuntime, frame: number): void {
    for (let index = rt.materializedEntryStart; index < rt.materializedEntryEnd; index += 1) {
        const node = rt.entryNodes[index];
        if (node === undefined || rt.entryNodeKinds[index] !== "tool_header") continue;
        const header = tuiGutterContent(node);
        if (header instanceof BoxRenderable) animateTuiToolHeader(header, frame);
    }
}

export function animateLiveThinking(rt: TuiRuntime, frame: number): void {
    for (let index = rt.materializedEntryStart; index < rt.materializedEntryEnd; index += 1) {
        const node = rt.entryNodes[index];
        if (node === undefined || rt.entryNodeKinds[index] !== "thinking") continue;
        const window = tuiGutterContent(node);
        if (window instanceof BoxRenderable) animateTuiThinkingWindow(window, frame);
    }
}

export function updateTranscriptEntryNode(rt: TuiRuntime, 
    wrapper: TextRenderable | MarkdownRenderable | BoxRenderable,
    entry: TuiTranscriptEntry,
): void {
    wrapper.visible = entry.kind !== "tool" || entry.hidden !== true;
    const existing = tuiGutterContent(wrapper);
    if (entry.kind === "worked" && existing instanceof BoxRenderable) {
        updateTuiWorkedDivider(existing, tuiWorkedDividerView(entry));
    }
    if (existing instanceof MarkdownRenderable) {
        if (existing.streaming && !rt.state.working) {
            existing.streaming = false;
        }
        if (existing.content !== tuiMarkdownEntryContent(entry)) {
            existing.content = tuiMarkdownEntryContent(entry);
        }
    }
    if (entry.kind === "tool" && existing instanceof BoxRenderable) {
        updateTuiToolRow(existing, entry);
    }
    if (
        entry.kind === "tool_header"
        && existing instanceof BoxRenderable
    ) {
        updateTuiToolHeader(existing, entry);
    }
    if (
        entry.kind === "thinking"
        && existing instanceof BoxRenderable
    ) {
        updateTuiThinkingWindow(existing, entry, rt.liveReasoningRows);
    }
    if (
        entry.kind === "notice" && entry.card === true
        && existing instanceof BoxRenderable
    ) {
        updateTuiNoticeCard(existing, entry);
    }
    if (tuiEntryIsErrorRow(entry) && existing instanceof BoxRenderable) {
        updateTuiErrorRow(existing, entry);
    }
    if (
        entry.kind === "thought"
        && existing instanceof BoxRenderable
    ) {
        updateTuiReasoningBlock(existing, entry);
    }
    if (
        (entry.kind === "notice"
            || entry.kind === "inbox")
        && existing instanceof TextRenderable
    ) {
        setTextContent(existing, renderTuiEntry(entry));
    }
}

export function createTranscriptEntryNode(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    index: number,
): TextRenderable | MarkdownRenderable | BoxRenderable {
    const entry = entries[index];
    if (entry === undefined) {
        throw new Error(`Transcript entry ${index} is unavailable`);
    }
    const streaming = tuiTranscriptEntryStreams(entries, index, rt.state.working);
    const node = createTuiEntryNode(rt, 
        `entry-${index}`,
        entry,
        tuiEntryMarginTop(entries, index, rt.entrySpacing),
        assistantFollowsTools(entries, index),
        streaming,
    );
    updateTranscriptEntryNode(rt, node, entry);
    // The node's own cache takes over; the estimate cache is for evicted rows.
    rt.reasoningRowCaches?.delete(index);
    rt.entryNodes[index] = node;
    rt.entryNodeKinds[index] = entry.kind;
    rt.entryNodeSources.set(node, entry);
    return node;
}

// A row's gap depends on the row above, which Ctrl+O or a history refresh can change.
function refreshEntryMargin(rt: TuiRuntime,
    node: TextRenderable | MarkdownRenderable | BoxRenderable,
    entries: readonly TuiTranscriptEntry[],
    index: number,
): void {
    // A user row draws its gap inside itself.
    if (entries[index]?.kind === "user") return;
    const margin = tuiEntryMarginTop(entries, index, rt.entrySpacing);
    if (node.marginTop !== margin) node.marginTop = margin;
}

export function destroyTranscriptEntryNode(rt: TuiRuntime, index: number): void {
    rt.entryNodes[index]?.destroyRecursively();
    delete rt.entryNodes[index];
    delete rt.entryNodeKinds[index];
}

export function transcriptWindowChildIndex(rt: TuiRuntime, index: number): number {
    return 1 + index - rt.materializedEntryStart;
}

export function addTranscriptEntryNode(rt: TuiRuntime, 
    node: TextRenderable | MarkdownRenderable | BoxRenderable,
    index: number,
): void {
    rt.transcriptEntryWindow.add(node, transcriptWindowChildIndex(rt, index));
}

export function updateTranscriptSpacers(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    const above = estimatedTranscriptRows(rt, entries, 0, rt.materializedEntryStart);
    const below = estimatedTranscriptRows(rt, 
        entries,
        rt.materializedEntryEnd,
        entries.length,
    );
    rt.transcriptWindowTopSpacer.height = above;
    rt.transcriptWindowTopSpacer.visible = above > 0;
    rt.transcriptWindowBottomSpacer.height = below;
    rt.transcriptWindowBottomSpacer.visible = below > 0;
}

export function topmostVisibleTranscriptEntry(rt: TuiRuntime): number | undefined {
    const top = rt.transcript.viewport.screenY;
    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        const node = rt.entryNodes[index];
        if (node === undefined || !node.visible) continue;
        if (node.screenY + node.height > top) return index;
    }
    return undefined;
}

// screenY is refreshed only by a render pass, so after calculateLayout the computed layout is the fresh source.
function transcriptNodeOffset(rt: TuiRuntime, node: Renderable): number {
    let top = 0;
    for (let at: Renderable | null = node; at !== null; at = at.parent) {
        if (at === rt.transcript.content) return top - rt.transcript.scrollTop;
        top += at.getLayoutNode().getComputedLayout().top;
    }
    return node.screenY - rt.transcript.viewport.screenY;
}

function anchoredOffset(
    anchor: NonNullable<TuiRuntime["pendingTranscriptScrollAnchor"]>,
    width: number,
    height: number,
): number {
    if (anchor.offset >= 0 || anchor.width === width || anchor.height <= 0) {
        return anchor.offset;
    }
    const hidden = Math.min(-anchor.offset, anchor.height - 1);
    return -Math.min(
        Math.floor((hidden + 0.5) * height / anchor.height),
        Math.max(0, height - 1),
    );
}

interface TuiTableLayout {
    readonly rowOffsets: readonly number[];
    readonly rowHeights: readonly number[];
}

function tableLayout(node: TextTableRenderable): TuiTableLayout | undefined {
    // OpenTUI stores table row geometry in its internal layout.
    const layout: unknown = Reflect.get(node, "_layout");
    if (typeof layout !== "object" || layout === null) return undefined;
    const offsets: unknown = Reflect.get(layout, "rowOffsets");
    const heights: unknown = Reflect.get(layout, "rowHeights");
    if (!Array.isArray(offsets) || !Array.isArray(heights)
        || offsets.length !== heights.length + 1
        || !offsets.every(Number.isFinite) || !heights.every(Number.isFinite)) return undefined;
    return { rowOffsets: offsets, rowHeights: heights };
}

function topTranscriptSource(node: Renderable, top: number): TuiTranscriptSourceAnchor | undefined {
    if (!node.visible || node.screenY > top || node.screenY + node.height <= top) {
        return undefined;
    }
    if (node instanceof TextBufferRenderable) {
        const row = top - node.screenY + node.scrollY;
        const info = node.lineInfo;
        const line = info.lineSources[row];
        const column = info.lineStartCols[row];
        if (line !== undefined && column !== undefined) return { kind: "text", node, line, column };
    }
    if (node instanceof TextTableRenderable) {
        const layout = tableLayout(node);
        if (layout !== undefined) {
            const localY = top - node.screenY;
            const row = layout.rowHeights.findIndex((height, index) => {
                const start = layout.rowOffsets[index]! + 1;
                return localY >= start && localY < start + height;
            });
            if (row !== -1) return { kind: "table", node, row };
        }
    }
    for (const child of node.getChildren()) {
        const source = topTranscriptSource(child, top);
        if (source !== undefined) return source;
    }
    return undefined;
}

function transcriptSourceRow(source: TuiTranscriptSourceAnchor): number | undefined {
    if (source.kind === "text") {
        const info = source.node.lineInfo;
        let bestRow = -1;
        let bestColumn = -1;
        let bestWrap = -1;
        for (let row = 0; row < info.lineSources.length; row += 1) {
            const column = info.lineStartCols[row];
            const wrap = info.lineWraps[row];
            if (info.lineSources[row] !== source.line || column === undefined
                || wrap === undefined || column > source.column) continue;
            if (column > bestColumn || (column === bestColumn && wrap > bestWrap)) {
                bestRow = row;
                bestColumn = column;
                bestWrap = wrap;
            }
        }
        return bestRow === -1 ? undefined : bestRow - source.node.scrollY;
    }
    const offset = tableLayout(source.node)?.rowOffsets[source.row];
    return offset === undefined ? undefined : offset + 1 + source.node.cellPaddingY;
}

export function applyTranscriptScrollAnchor(rt: TuiRuntime): void {
    const anchor = rt.pendingTranscriptScrollAnchor;
    if (anchor === undefined) return;
    rt.pendingTranscriptScrollAnchor = undefined;
    const node = rt.entryNodes[anchor.index];
    if (node === undefined) return;
    const { width, height } = node.getLayoutNode().getComputedLayout();
    if (width !== anchor.width && anchor.source !== undefined && !anchor.source.node.isDestroyed) {
        const row = transcriptSourceRow(anchor.source);
        if (row !== undefined) {
            const offset = transcriptNodeOffset(rt, anchor.source.node) + row;
            const target = rt.transcript.scrollTop + offset;
            if (anchor.minimumScrollHeight !== undefined
                && rt.transcript.scrollHeight < anchor.minimumScrollHeight) {
                rt.pendingTranscriptScrollAnchor = anchor;
                return;
            }
            const missing = target + rt.transcript.viewport.height + 2 - rt.transcript.scrollHeight;
            if (missing > 0) {
                rt.transcriptAnchorPadding += missing;
                rt.transcriptAnchorSpacer.height = rt.transcriptAnchorPadding;
                rt.transcriptAnchorSpacer.visible = true;
                rt.pendingTranscriptScrollAnchor = {
                    ...anchor,
                    minimumScrollHeight: rt.transcript.scrollHeight + missing,
                };
                return;
            }
            rt.transcript.scrollTo(target);
            return;
        }
    }
    const target = anchoredOffset(anchor, width, height);
    const offset = transcriptNodeOffset(rt, node);
    if (offset === target) return;
    rt.transcript.scrollTo(rt.transcript.scrollTop + offset - target);
}

export function clearTranscriptAnchorPadding(rt: TuiRuntime): void {
    if (rt.transcriptAnchorPadding === 0) return;
    rt.transcriptAnchorPadding = 0;
    rt.transcriptAnchorSpacer.height = 0;
    rt.transcriptAnchorSpacer.visible = false;
    rt.pendingTranscriptAnchorPaddingClear = true;
}

export function captureTranscriptScrollAnchor(rt: TuiRuntime): void {
    rt.pendingTranscriptScrollAnchor = undefined;
    const index = topmostVisibleTranscriptEntry(rt);
    if (index === undefined) return;
    const node = rt.entryNodes[index];
    if (node === undefined) return;
    const { width, height } = node.getLayoutNode().getComputedLayout();
    let source = topTranscriptSource(tuiGutterContent(node), rt.transcript.viewport.screenY);
    const retained = rt.transcriptResizeAnchor;
    if (source?.kind === "text") {
        const sameSource = retained !== undefined && retained.index === index
            && retained.entries === rt.state.entries && retained.source.node === source.node
            && retained.source.line === source.line && !retained.source.node.isDestroyed;
        const retainedRow = sameSource ? transcriptSourceRow(retained.source) : undefined;
        if (sameSource && retainedRow !== undefined
            && source.node.screenY + retainedRow === rt.transcript.viewport.screenY) {
            source = retained.source;
        } else {
            rt.transcriptResizeAnchor = { index, entries: rt.state.entries, source };
        }
    } else {
        rt.transcriptResizeAnchor = undefined;
    }
    rt.pendingTranscriptScrollAnchor = {
        index,
        offset: transcriptNodeOffset(rt, node),
        width,
        height,
        source,
    };
}

export function transcriptFollowsBottom(rt: TuiRuntime): boolean {
    return rt.transcript.stickyScroll && tuiTranscriptAtBottom(
        rt.transcript.scrollTop,
        rt.transcript.scrollHeight,
        rt.transcript.viewport.height,
    );
}

export function trimTranscriptWindow(rt: TuiRuntime, length: number): void {
    for (let index = length; index < rt.entryNodes.length; index += 1) {
        destroyTranscriptEntryNode(rt, index);
    }
    rt.entryNodes.length = Math.min(rt.entryNodes.length, length);
    rt.entryNodeKinds.length = rt.entryNodes.length;
    rt.measuredEntryRows.length = Math.min(rt.measuredEntryRows.length, length);
    rt.materializedEntryEnd = Math.min(rt.materializedEntryEnd, length);
    rt.materializedEntryStart = Math.min(
        rt.materializedEntryStart,
        rt.materializedEntryEnd,
    );
}

export function renderTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    if (rt.transcriptResizeAnchor !== undefined && rt.transcriptResizeAnchor.entries !== entries) {
        rt.transcriptResizeAnchor = undefined;
    }
    if (rt.pendingTranscriptReseed) {
        rt.pendingTranscriptReseed = false;
        reseedTranscriptNodes(rt, entries);
    }
    trimTranscriptWindow(rt, entries.length);

    if (entries.length === 0) {
        rt.transcriptWindowTopSpacer.height = 0;
        rt.transcriptWindowTopSpacer.visible = false;
        rt.transcriptWindowBottomSpacer.height = 0;
        rt.transcriptWindowBottomSpacer.visible = false;
        return;
    }

    if (rt.materializedEntryEnd === 0 && rt.entryNodes.length === 0) {
        const initial = tuiTranscriptTailRange(entries.length);
        rt.materializedEntryStart = initial.start;
        rt.materializedEntryEnd = initial.start;
    }

    let materializeTo = transcriptFollowsBottom(rt)
        ? entries.length
        : Math.min(rt.materializedEntryEnd, entries.length);

    // Nodes exist only inside the materialized window, so the scan stops there.
    let changedKindAt = -1;
    for (
        let index = rt.materializedEntryStart;
        index < Math.min(rt.materializedEntryEnd, entries.length);
        index += 1
    ) {
        if (
            rt.entryNodes[index] !== undefined
            && rt.entryNodeKinds[index] !== entries[index]?.kind
        ) {
            changedKindAt = index;
            break;
        }
    }
    if (changedKindAt !== -1) {
        materializeTo = Math.max(materializeTo, rt.materializedEntryEnd);
        rt.pendingTranscriptScrollRestore = {
            scrollTop: rt.transcript.scrollTop,
            atBottom: transcriptFollowsBottom(rt),
        };
        for (
            let index = changedKindAt;
            index < rt.materializedEntryEnd;
            index += 1
        ) {
            destroyTranscriptEntryNode(rt, index);
        }
        rt.materializedEntryEnd = changedKindAt;
    }

    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        const node = rt.entryNodes[index];
        const entry = entries[index];
        if (node !== undefined && entry !== undefined) {
            updateTranscriptEntryNode(rt, node, entry);
            refreshEntryMargin(rt, node, entries, index);
            rt.entryNodeSources.set(node, entry);
        }
    }

    for (let index = rt.materializedEntryEnd; index < materializeTo; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    rt.materializedEntryEnd = Math.max(rt.materializedEntryEnd, materializeTo);
    updateTranscriptSpacers(rt, entries);
}

export function materializeEarlierTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): boolean {
    const range = tuiTranscriptPrependRange(rt.materializedEntryStart);
    if (range.start === range.end) return false;
    captureTranscriptScrollAnchor(rt);
    rt.materializedEntryStart = range.start;
    for (let index = range.start; index < range.end; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    updateTranscriptSpacers(rt, entries);
    return true;
}

export function materializeLaterTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): boolean {
    const end = Math.min(
        entries.length,
        rt.materializedEntryEnd + TUI_TRANSCRIPT_MATERIALIZE_BATCH,
    );
    if (end <= rt.materializedEntryEnd) return false;
    for (let index = rt.materializedEntryEnd; index < end; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    rt.materializedEntryEnd = end;
    updateTranscriptSpacers(rt, entries);
    return true;
}

export function nodeTranscriptRows(rt: TuiRuntime, index: number): number | undefined {
    const node = rt.entryNodes[index];
    if (node === undefined) return undefined;
    const margin = node.marginTop;
    return node.height + (typeof margin === "number" ? margin : 0);
}

export function evictTranscriptEntries(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): boolean {
    const materializedAbove = Math.max(
        0,
        rt.transcript.scrollTop - rt.transcriptWindowTopSpacer.height,
    );
    const materializedBelow = Math.max(
        0,
        rt.transcript.scrollHeight
            - rt.transcriptWindowBottomSpacer.height
            - rt.transcript.scrollTop
            - rt.transcript.viewport.height,
    );
    const headroom = rt.materializedEntryEnd
        - rt.materializedEntryStart
        - TUI_TRANSCRIPT_INITIAL_WINDOW;
    if (headroom <= 0) return false;

    const aboveBudget = tuiTranscriptEvictableRows({
        scrollTop: rt.transcript.scrollTop,
        viewportHeight: rt.transcript.viewport.height,
        spacerHeight: rt.transcriptWindowTopSpacer.height,
    });
    if (aboveBudget > 0 && materializedAbove > 0) {
        const limit = Math.min(
            rt.materializedEntryStart + TUI_TRANSCRIPT_MATERIALIZE_BATCH,
            rt.materializedEntryStart + headroom,
        );
        let released = 0;
        let index = rt.materializedEntryStart;
        while (index < limit) {
            const rows = nodeTranscriptRows(rt, index);
            if (rows === undefined || released + rows > aboveBudget) break;
            measureTranscriptEntryNode(rt, index);
            released += rows;
            index += 1;
        }
        if (index > rt.materializedEntryStart) {
            for (let drop = rt.materializedEntryStart; drop < index; drop += 1) {
                destroyTranscriptEntryNode(rt, drop);
            }
            rt.materializedEntryStart = index;
            updateTranscriptSpacers(rt, entries);
            return true;
        }
    }

    const belowBudget = tuiTranscriptEvictableRows({
        scrollTop: materializedBelow,
        viewportHeight: rt.transcript.viewport.height,
        spacerHeight: 0,
    });
    if (belowBudget <= 0) return false;
    const floor = Math.max(
        rt.materializedEntryStart,
        rt.materializedEntryEnd - TUI_TRANSCRIPT_MATERIALIZE_BATCH,
        rt.materializedEntryEnd - headroom,
    );
    let released = 0;
    let index = rt.materializedEntryEnd;
    while (index > floor) {
        const rows = nodeTranscriptRows(rt, index - 1);
        if (rows === undefined || released + rows > belowBudget) break;
        measureTranscriptEntryNode(rt, index - 1);
        released += rows;
        index -= 1;
    }
    if (index === rt.materializedEntryEnd) return false;
    for (let drop = index; drop < rt.materializedEntryEnd; drop += 1) {
        destroyTranscriptEntryNode(rt, drop);
    }
    rt.materializedEntryEnd = index;
    updateTranscriptSpacers(rt, entries);
    return true;
}

export function maybeEvictTranscriptEntries(rt: TuiRuntime): boolean {
    if (rt.state.entries.length === 0) return false;
    return evictTranscriptEntries(rt, rt.state.entries);
}

export function setTranscriptWindow(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    start: number,
    end: number,
): void {
    for (let index = rt.materializedEntryStart; index < rt.materializedEntryEnd; index += 1) {
        measureTranscriptEntryNode(rt, index);
        destroyTranscriptEntryNode(rt, index);
    }
    rt.materializedEntryStart = start;
    rt.materializedEntryEnd = start;
    for (let index = start; index < end; index += 1) {
        addTranscriptEntryNode(rt, 
            createTranscriptEntryNode(rt, entries, index),
            index,
        );
    }
    rt.materializedEntryEnd = end;
    updateTranscriptSpacers(rt, entries);
    rt.pendingTranscriptScrollAnchor = undefined;
}

export function snapTranscriptWindowToTail(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    clearTranscriptAnchorPadding(rt);
    rt.transcriptResizeAnchor = undefined;
    const tail = tuiTranscriptTailRange(entries.length);
    setTranscriptWindow(rt, entries, tail.start, tail.end);
    resumeTuiTranscriptFollow(rt.transcript);
    rt.pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
}

export function setTranscriptWindowAround(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
    index: number,
): void {
    const start = Math.max(
        0,
        Math.min(
            index - Math.floor(TUI_TRANSCRIPT_INITIAL_WINDOW / 2),
            entries.length - TUI_TRANSCRIPT_INITIAL_WINDOW,
        ),
    );
    setTranscriptWindow(rt, 
        entries,
        start,
        Math.min(entries.length, start + TUI_TRANSCRIPT_INITIAL_WINDOW),
    );
}

export function settleTranscriptScrollState(rt: TuiRuntime): void {
    const restore = rt.pendingTranscriptScrollRestore;
    if (restore !== undefined) {
        rt.pendingTranscriptScrollRestore = undefined;
        rt.pendingTranscriptScrollAnchor = undefined;
        if (restore.atBottom) {
            clearTranscriptAnchorPadding(rt);
            rt.transcriptResizeAnchor = undefined;
        }
        if (restore.atBottom) resumeTuiTranscriptFollow(rt.transcript);
        else rt.transcript.scrollTo(restore.scrollTop);
    }
    applyTranscriptScrollAnchor(rt);
}

export function maybeMaterializeEarlierTranscriptEntries(rt: TuiRuntime): boolean {
    if (rt.state.entries.length === 0) return false;
    if (!tuiTranscriptNeedsEarlierEntries({
        materializedStart: rt.materializedEntryStart,
        scrollTop: rt.transcript.scrollTop,
        viewportHeight: rt.transcript.viewport.height,
        spacerTop: rt.transcriptWindowTopSpacer.screenY
            - rt.transcript.viewport.screenY
            + rt.transcript.scrollTop,
        spacerHeight: rt.transcriptWindowTopSpacer.height,
    })) {
        return false;
    }
    return materializeEarlierTranscriptEntries(rt, rt.state.entries);
}

export function maybeMaterializeLaterTranscriptEntries(rt: TuiRuntime): boolean {
    if (rt.materializedEntryEnd >= rt.state.entries.length) return false;
    const buffer = Math.max(1, rt.transcript.viewport.height)
        * TUI_TRANSCRIPT_MATERIALIZE_BUFFER;
    const materializedEdge = rt.transcript.scrollHeight
        - rt.transcriptWindowBottomSpacer.height;
    if (
        rt.transcript.scrollTop + rt.transcript.viewport.height + buffer
            < materializedEdge
    ) {
        return false;
    }
    return materializeLaterTranscriptEntries(rt, rt.state.entries);
}

export function maybeSnapTranscriptWindowToTail(rt: TuiRuntime): boolean {
    if (rt.state.entries.length === 0) return false;
    if (rt.materializedEntryEnd >= rt.state.entries.length) return false;
    if (!transcriptFollowsBottom(rt)) return false;
    snapTranscriptWindowToTail(rt, rt.state.entries);
    return true;
}
