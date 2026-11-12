import { resumeTuiTranscriptFollow, tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import { renderSidebarJump } from "./notices.ts";
import { resetHistoryPagingState } from "../history-paging-state.ts";
import { applyPendingHistoryAnchor } from "./render-state.ts";
import { BoxRenderable, CliRenderEvents, type Renderable } from "@opentui/core";
import type { IdentifiedTuiAgentClient } from "../agent-client.ts";
import type { TuiAgentPane } from "../agent-pane.ts";
import { applyPendingHistoryScroll, captureHistoryAnchor, maybeRequestEarlierHistory } from "./history-paging.ts";
import type { TuiRuntime } from "./runtime.ts";
import {
    applyTranscriptScrollAnchor,
    clearTranscriptAnchorPadding,
    measureMaterializedTranscriptEntries,
    maybeEvictTranscriptEntries,
    maybeMaterializeEarlierTranscriptEntries,
    maybeMaterializeLaterTranscriptEntries,
    maybeSnapTranscriptWindowToTail,
    reanchorTranscriptWindowAboveView,
    renderTranscriptEntries,
    settleTranscriptScrollState,
} from "./transcript-nodes.ts";

interface SidebarView {
    readonly pane: TuiAgentPane<IdentifiedTuiAgentClient>;
    readonly runtime: TuiRuntime;
}

const views = new WeakMap<TuiRuntime, SidebarView>();
const listeners = new WeakSet<TuiRuntime>();

// clear() detaches the view's nodes and an owner extension can append a block
// outside it; the next render rebuilds instead of inserting around nothing.
function transcriptDomOwned(rt: TuiRuntime, view: SidebarView): boolean {
    const children = rt.sidebar.content.getChildren();
    const top = view.runtime.transcriptWindowTopSpacer;
    const bottom = view.runtime.transcriptWindowBottomSpacer;
    if (!children.includes(top) || !children.includes(bottom)) return false;
    const owned = new Set<Renderable>([top, bottom, view.runtime.transcriptAnchorSpacer]);
    for (const node of view.runtime.entryNodes) {
        if (node !== undefined) owned.add(node);
    }
    return children.every((child) => owned.has(child));
}

export function destroySidebarTranscript(rt: TuiRuntime): void {
    const view = views.get(rt);
    if (view === undefined) return;
    views.delete(rt);
    resetHistoryPagingState(view.pane.state.historyPaging, false);
    rt.sidebar.setTranscriptBlocks(undefined);
    for (const node of view.runtime.entryNodes) node?.destroyRecursively();
    view.runtime.entryNodes.length = 0;
    view.runtime.entryNodeKinds.length = 0;
    view.runtime.transcriptWindowTopSpacer.destroyRecursively();
    view.runtime.transcriptWindowBottomSpacer.destroyRecursively();
    view.runtime.transcriptAnchorSpacer.destroyRecursively();
    rt.sidebarEntryNodes = [];
    rt.sidebarEntryNodeKinds = [];
}

function createView(rt: TuiRuntime, pane: TuiAgentPane<IdentifiedTuiAgentClient>): SidebarView {
    const top = new BoxRenderable(rt.renderer, {
        id: "sidebar-transcript-top", width: "100%", height: 0, flexShrink: 0,
    });
    const bottom = new BoxRenderable(rt.renderer, {
        id: "sidebar-transcript-bottom", width: "100%", height: 0, visible: false, flexShrink: 0,
    });
    const anchorSpacer = new BoxRenderable(rt.renderer, {
        id: "sidebar-transcript-anchor", width: "100%", height: 0, visible: false, flexShrink: 0,
    });
    // Entries are direct children of the scroll content, between the spacers,
    // so OpenTUI's viewport culling can skip the rows outside the viewport.
    rt.sidebar.clear();
    rt.sidebar.content.add(top);
    rt.sidebar.content.add(bottom);
    const local: Record<string, unknown> = {
        client: pane.client,
        clientGeneration: 0,
        conversationGeneration: 0,
        historyPaging: pane.state.historyPaging,
        transcript: rt.sidebar.content,
        transcriptEntryOwner: rt,
        searchLanding: undefined,
        transcriptWindowTopSpacer: top,
        transcriptWindowBottomSpacer: bottom,
        transcriptAnchorSpacer: anchorSpacer,
        transcriptAnchorPadding: 0,
        pendingTranscriptAnchorPaddingClear: false,
        transcriptResizeAnchor: undefined,
        entryNodes: [],
        entryNodeKinds: [],
        entryNodeSources: new WeakMap(),
        materializedEntryStart: 0,
        materializedEntryEnd: 0,
        measuredEntryRows: [],
        measuredEntryRowsWidth: 0,
        reasoningRowCaches: undefined,
        pendingTranscriptReseed: true,
        pendingTranscriptScrollRestore: undefined,
        pendingTranscriptScrollAnchor: undefined,
        pendingSearchTarget: undefined,
        experimentalTuiHost: { clearTranscriptRenderables: () => undefined },
        renderCoalescer: { request: () => renderSidebarTranscript(rt, pane, true) },
    };
    const runtime = new Proxy(rt, {
        get(target, key, receiver) {
            if (key === "state") return pane.state.state;
            if (typeof key === "string" && key in local) return local[key];
            return Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
            if (key === "state") {
                pane.state.state = value;
                return true;
            }
            if (typeof key === "string" && key in local) {
                local[key] = value;
                return true;
            }
            return Reflect.set(target, key, value, receiver);
        },
    });
    rt.sidebarEntryNodes = runtime.entryNodes;
    rt.sidebarEntryNodeKinds = runtime.entryNodeKinds;
    rt.sidebar.content.onMouseScroll = (event) => {
        if (views.get(rt)?.pane !== pane || event.modifiers.shift) return;
        if (event.scroll?.direction === "up") {
            pane.state.historyPaging.needsScroll = false;
            rt.renderer.requestRender();
        }
        const direction = event.scroll?.direction;
        if (direction === "up" || direction === "down") {
            const previousTop = runtime.transcript.scrollTop;
            pane.state.historyPaging.anchor = undefined;
            queueMicrotask(() => {
                if (views.get(rt)?.pane !== pane) return;
                if (direction === "up" && runtime.transcript.scrollTop < previousTop) {
                    runtime.transcript.stickyScroll = false;
                    if (runtime.pendingTranscriptScrollRestore?.atBottom) {
                        runtime.pendingTranscriptScrollRestore = undefined;
                    }
                } else if (direction === "down" && tuiTranscriptAtBottom(
                    runtime.transcript.scrollTop,
                    runtime.transcript.scrollHeight,
                    runtime.transcript.viewport.height,
                )) {
                    resumeTuiTranscriptFollow(runtime.transcript);
                }
                reanchorTranscriptWindowAboveView(runtime);
                renderSidebarJump(rt);
                rt.renderer.requestRender();
            });
        }
    };
    return { pane, runtime };
}

function syncSelection(rt: TuiRuntime, view: SidebarView): void {
    const entries = view.pane.state.state.entries;
    const blocks = [];
    for (let index = view.runtime.materializedEntryStart; index < view.runtime.materializedEntryEnd; index += 1) {
        const node = view.runtime.entryNodes[index];
        if (node !== undefined) {
            blocks.push({ node, speaker: entries[index]?.kind === "user" ? "you" : "agent" });
        }
    }
    rt.sidebar.setTranscriptBlocks(blocks);
}

function frame(rt: TuiRuntime): void {
    const view = views.get(rt);
    if (view === undefined || view.pane !== rt.hostedSidebar.pane || !rt.sidebar.isShown()) return;
    const side = view.runtime;
    settleTranscriptScrollState(side);
    measureMaterializedTranscriptEntries(side);
    let changed = false;
    if (side.historyPaging.anchor === undefined) {
        changed = maybeSnapTranscriptWindowToTail(side)
            || maybeMaterializeEarlierTranscriptEntries(side)
            || maybeMaterializeLaterTranscriptEntries(side)
            || maybeEvictTranscriptEntries(side);
    }
    if (changed) syncSelection(rt, view);
    applyPendingHistoryScroll(side);
    if (side.pendingTranscriptScrollAnchor !== undefined) {
        side.renderer.root.calculateLayout();
        applyTranscriptScrollAnchor(side);
    }
    maybeRequestEarlierHistory(side);
}

export function jumpSidebarToBottom(rt: TuiRuntime): void {
    const view = views.get(rt);
    if (view === undefined || view.pane !== rt.hostedSidebar.pane) {
        rt.sidebar.scrollToBottom();
        return;
    }
    const side = view.runtime;
    side.transcriptResizeAnchor = undefined;
    clearTranscriptAnchorPadding(side);
    side.historyPaging.anchor = undefined;
    settleTranscriptScrollState(side);
    resumeTuiTranscriptFollow(side.transcript);
    rt.renderer.requestRender();
}

export function noteSidebarHistoryUpdate(rt: TuiRuntime, pane: TuiAgentPane<IdentifiedTuiAgentClient>): void {
    const view = views.get(rt);
    if (view?.pane === pane) view.runtime.pendingTranscriptReseed = true;
}

export function renderSidebarTranscript(
    rt: TuiRuntime,
    pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    requestPaint: boolean,
    repaintTheme = false,
): void {
    if (pane !== rt.hostedSidebar.pane) return;
    let view = views.get(rt);
    if (view !== undefined && (view.pane !== pane || !transcriptDomOwned(rt, view))) {
        destroySidebarTranscript(rt);
        view = undefined;
    }
    if (view === undefined) {
        view = createView(rt, pane);
        views.set(rt, view);
    }
    if (!listeners.has(rt)) {
        listeners.add(rt);
        rt.renderer.on(CliRenderEvents.FRAME, () => frame(rt));
    }
    if (repaintTheme) {
        view.runtime.historyPaging.anchor = captureHistoryAnchor(view.runtime);
        for (const node of view.runtime.entryNodes) node?.destroyRecursively();
        view.runtime.entryNodes.length = 0;
        view.runtime.entryNodeKinds.length = 0;
        view.runtime.materializedEntryStart = 0;
        view.runtime.materializedEntryEnd = 0;
        view.runtime.pendingTranscriptReseed = true;
    }
    renderTranscriptEntries(view.runtime, pane.state.state.entries);
    applyPendingHistoryAnchor(view.runtime);
    syncSelection(rt, view);
    if (requestPaint) rt.renderCoalescer.request("sidebar");
}
