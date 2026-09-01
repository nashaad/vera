import { tuiGutterContent, tuiGutterWidth } from "../gutter.ts";
import { assistantFollowsTools, reseedTranscriptNodes } from "../main.ts";
import { createTuiEntryNode, mainTranscriptWidth } from "../main/sidebar-pane.ts";
import { tuiMarkdownEntryContent } from "../markdown-entry.ts";
import { renderTuiEntry, tuiEntryMarginTop, type TuiTranscriptEntry } from "../state.ts";
import { updateTuiThinkingWindow } from "../thinking-window.ts";
import { saveTuiTipState } from "../tips-store.ts";
import { TUI_TIPS, recordTuiTipShown, selectTuiTip, type TuiTip, type TuiTipContext } from "../tips.ts";
import { updateTuiToolHeader, updateTuiToolRow } from "../tool-row.ts";
import { tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import { TUI_TRANSCRIPT_INITIAL_WINDOW, TUI_TRANSCRIPT_MATERIALIZE_BATCH, TUI_TRANSCRIPT_MATERIALIZE_BUFFER, tuiTranscriptEntryIsVisible, tuiTranscriptEntryStreams, tuiTranscriptEvictableRows, tuiTranscriptNeedsEarlierEntries, tuiTranscriptPrependRange, tuiTranscriptTailRange } from "../transcript-window.ts";
import type { TuiRuntime } from "./runtime.ts";
import { BoxRenderable, MarkdownRenderable, TextRenderable } from "@opentui/core";

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
    return entry.kind === "diff"
        ? `${entry.path}\n${entry.patch}`
        : entry.text;
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
    if (entry.kind === "thinking") {
        return margin + 1;
    }
    return margin + Math.max(
        1,
        transcriptEstimatedRows(rt, transcriptEntryText(rt, entry), width),
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

export function updateTranscriptEntryNode(rt: TuiRuntime, 
    wrapper: TextRenderable | MarkdownRenderable | BoxRenderable,
    entry: TuiTranscriptEntry,
): void {
    wrapper.visible = entry.kind !== "tool" || entry.hidden !== true;
    const existing = tuiGutterContent(wrapper);
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
        updateTuiThinkingWindow(existing, entry);
    }
    if (
        (entry.kind === "thought"
            || entry.kind === "notice"
            || entry.kind === "inbox")
        && existing instanceof TextRenderable
    ) {
        existing.content = renderTuiEntry(entry);
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
    rt.entryNodes[index] = node;
    rt.entryNodeKinds[index] = entry.kind;
    rt.entryNodeSources.set(node, entry);
    return node;
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

export function applyTranscriptScrollAnchor(rt: TuiRuntime): void {
    const anchor = rt.pendingTranscriptScrollAnchor;
    if (anchor === undefined) return;
    rt.pendingTranscriptScrollAnchor = undefined;
    const node = rt.entryNodes[anchor.index];
    if (node === undefined) return;
    const offset = node.screenY - rt.transcript.viewport.screenY;
    if (offset === anchor.offset) return;
    rt.transcript.scrollTo(rt.transcript.scrollTop + offset - anchor.offset);
}

export function captureTranscriptScrollAnchor(rt: TuiRuntime): void {
    rt.pendingTranscriptScrollAnchor = undefined;
    const index = topmostVisibleTranscriptEntry(rt);
    if (index === undefined) return;
    const node = rt.entryNodes[index];
    if (node === undefined) return;
    rt.pendingTranscriptScrollAnchor = {
        index,
        offset: node.screenY - rt.transcript.viewport.screenY,
    };
}

export function transcriptFollowsBottom(rt: TuiRuntime): boolean {
    return tuiTranscriptAtBottom(
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

    const changedKindAt = entries.findIndex((entry, index) =>
        rt.entryNodes[index] !== undefined
        && rt.entryNodeKinds[index] !== entry.kind
    );
    if (changedKindAt !== -1) {
        materializeTo = Math.max(materializeTo, rt.materializedEntryEnd);
        rt.pendingTranscriptScrollRestore = {
            scrollTop: rt.transcript.scrollTop,
            atBottom: tuiTranscriptAtBottom(
                rt.transcript.scrollTop,
                rt.transcript.scrollHeight,
                rt.transcript.viewport.height,
            ),
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
    const tail = tuiTranscriptTailRange(entries.length);
    setTranscriptWindow(rt, entries, tail.start, tail.end);
    rt.transcript.scrollTo(rt.transcript.scrollHeight);
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
        rt.transcript.scrollTo(
            restore.atBottom ? rt.transcript.scrollHeight : restore.scrollTop,
        );
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
