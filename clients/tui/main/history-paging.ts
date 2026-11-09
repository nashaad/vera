import { HistoryPageRequestError } from "../../../src/host/attached-client.ts";
import { HOST_CAPABILITY_AGENT_HISTORY_PAGING } from "../../../src/host/capabilities.ts";
import {
    historyUserPrompts,
    historyWindowFirstUserText,
    historyWindowMoved,
} from "../../shared/history-window.ts";
import { adoptFallbackSessionTitle } from "./chrome.ts";
import {
    applyHistoryPage,
    setEarlierHistoryStatus,
} from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import {
    estimatedTranscriptRows,
    shiftTranscriptWindowForPrepend,
    topmostVisibleTranscriptEntry,
    transcriptEntryOffsetTop,
    transcriptFollowsBottom,
    transcriptNodeOffset,
} from "./transcript-nodes.ts";

/** Request the next page before the top is reached, not when it is already hit. */
const EARLIER_HISTORY_PREFETCH_ROWS = 24;
const EARLIER_HISTORY_RETRY_DELAY_MS = 1_000;

export interface HistoryAnchor {
    readonly entryId: string;
    readonly offset: number;
}

export function resetHistoryPaging(rt: TuiRuntime): void {
    rt.earlierHistoryRequest = undefined;
    rt.earlierHistoryRetryAt = undefined;
    rt.earlierHistoryNeedsScroll = false;
    rt.earlierHistoryBlocked = false;
    rt.pendingHistoryAnchor = undefined;
}

export function captureHistoryAnchor(rt: TuiRuntime): HistoryAnchor | undefined {
    if (transcriptFollowsBottom(rt)) return undefined;
    const visible = topmostVisibleTranscriptEntry(rt);
    if (visible === undefined) return undefined;
    for (let index = visible; index < rt.materializedEntryEnd; index += 1) {
        const row = rt.state.entries[index];
        if (row === undefined || row.kind === "diff" || row.entryId === undefined) {
            continue;
        }
        const node = rt.entryNodes[index];
        // A hidden node lays out at top 0, so an offset taken from it places the view inside the top spacer.
        if (node === undefined || !node.visible) continue;
        return {
            entryId: row.entryId,
            offset: transcriptNodeOffset(rt, node),
        };
    }
    return undefined;
}

function withinPrefetchRange(rt: TuiRuntime): boolean {
    if (rt.transcript.scrollHeight <= rt.transcript.viewport.height) return true;
    if (transcriptFollowsBottom(rt)) return false;
    return rt.transcript.scrollTop <= EARLIER_HISTORY_PREFETCH_ROWS;
}

function canRequest(rt: TuiRuntime, force: boolean): boolean {
    const window = rt.state.historyWindow;
    return !rt.shuttingDown
        && window !== undefined
        && window.hasEarlier
        && window.olderBefore !== undefined
        && !rt.earlierHistoryBlocked
        && (force || !rt.earlierHistoryNeedsScroll)
        && rt.state.earlierHistory !== "too_large"
        && rt.earlierHistoryRequest === undefined
        && (rt.earlierHistoryRetryAt === undefined
            || Date.now() >= rt.earlierHistoryRetryAt)
        && rt.client.requestHistoryPage !== undefined
        && rt.client.supportsHostCapability?.(
            HOST_CAPABILITY_AGENT_HISTORY_PAGING,
        ) === true;
}

/** Returns true when a page request was started. */
export function maybeRequestEarlierHistory(
    rt: TuiRuntime,
    options: { readonly force?: boolean } = {},
): boolean {
    const force = options.force === true;
    if (!canRequest(rt, force)) return false;
    const requestPage = rt.client.requestHistoryPage;
    if (requestPage === undefined) return false;
    if (!force && !withinPrefetchRange(rt)) return false;
    const window = rt.state.historyWindow;
    if (window === undefined || window.olderBefore === undefined) return false;
    const before = window.olderBefore;
    const generation = rt.clientGeneration;
    rt.earlierHistoryRequest = { generation, before };
    const previousEntries = rt.state.entries;
    // This row is inserted now, so its anchor cannot go stale while a page
    // is in flight.
    const loadingAnchor = captureHistoryAnchor(rt);
    rt.state = setEarlierHistoryStatus(rt.state, "loading");
    const loadingDelta = rt.state.entries.length - previousEntries.length;
    if (!shiftTranscriptWindowForPrepend(rt, previousEntries, loadingDelta)) {
        rt.pendingHistoryAnchor = loadingAnchor;
        rt.pendingTranscriptReseed = true;
    }
    rt.renderCoalescer.request("history_page");

    void requestPage(before).then((response) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        rt.earlierHistoryRequest = undefined;
        rt.earlierHistoryRetryAt = undefined;
        if (rt.state.historyWindow?.olderBefore !== before) {
            // A checkpoint moved the cursor while the page was out; drop it and
            // let the next frame ask from the new cursor.
            rt.state = setEarlierHistoryStatus(rt.state, undefined);
            rt.pendingTranscriptReseed = true;
            rt.renderCoalescer.request("history_page");
            return;
        }
        rt.pendingHistoryAnchor = captureHistoryAnchor(rt);
        rt.earlierHistoryNeedsScroll = true;
        const previousEntries = rt.state.entries;
        const previousWindow = rt.state.historyWindow;
        rt.state = applyHistoryPage(rt.state, response);
        if (!historyWindowMoved(previousWindow, rt.state.historyWindow)) {
            // A page that moves nothing must not be asked again on the next frame.
            rt.earlierHistoryRetryAt = Date.now() + EARLIER_HISTORY_RETRY_DELAY_MS;
        }
        const delta = rt.state.entries.length - previousEntries.length;
        const shifted = shiftTranscriptWindowForPrepend(
            rt,
            previousEntries,
            delta,
        );
        if (shifted) {
            rt.pendingTranscriptReseed = false;
        } else {
            rt.pendingTranscriptReseed = true;
        }
        const added = (rt.state.historyWindow?.entries.length ?? 0) - (previousWindow?.entries.length ?? 0);
        if (added > 0) {
            rt.composer.prependSubmittedPrompts(historyUserPrompts(rt.state.historyWindow!.entries.slice(0, added)));
        }
        const firstText = historyWindowFirstUserText(
            rt.state.historyWindow ?? { entries: [], hasEarlier: false },
        );
        if (firstText !== undefined) {
            adoptFallbackSessionTitle(rt, firstText);
        }
        rt.renderCoalescer.request("history_page");
    }).catch((error: unknown) => {
        if (rt.shuttingDown || generation !== rt.clientGeneration) return;
        rt.earlierHistoryRequest = undefined;
        if (error instanceof HistoryPageRequestError) {
            if (error.reason === "page_too_large") {
                rt.earlierHistoryBlocked = true;
                rt.state = setEarlierHistoryStatus(rt.state, "too_large");
                rt.pendingTranscriptReseed = true;
                rt.renderCoalescer.request("history_page");
                return;
            }
            rt.earlierHistoryRetryAt = Date.now() + EARLIER_HISTORY_RETRY_DELAY_MS;
            rt.state = setEarlierHistoryStatus(rt.state, "failed");
            rt.pendingTranscriptReseed = true;
            rt.renderCoalescer.request("history_page");
            return;
        }
        // The attachment went away (reconnect or detach). No row: the next
        // frame retries once a new attachment is ready.
        rt.earlierHistoryRetryAt = Date.now() + EARLIER_HISTORY_RETRY_DELAY_MS;
        rt.state = setEarlierHistoryStatus(rt.state, undefined);
        rt.pendingTranscriptReseed = true;
        rt.renderCoalescer.request("history_page");
    });
    return true;
}

/**
 * The page window starts at the anchor row, so the anchor's offset from the
 * transcript top is the top spacer plus its row offset. Retry until the
 * scrollbar has the new content size.
 */
export function applyPendingHistoryScroll(rt: TuiRuntime): void {
    const anchor = rt.pendingHistoryAnchor;
    if (anchor === undefined || anchor.placed !== true) return;
    const index = rt.state.entries.findIndex((entry) =>
        entry.kind !== "diff" && entry.entryId === anchor.entryId
    );
    if (index === -1) {
        rt.pendingHistoryAnchor = undefined;
        return;
    }
    const target = transcriptEntryOffsetTop(
        rt,
        rt.state.entries,
        index,
    ) - anchor.offset;
    rt.transcript.scrollTo(target);
    const max = Math.max(0, rt.transcript.scrollHeight - rt.transcript.viewport.height);
    const contentRows = estimatedTranscriptRows(
        rt,
        rt.state.entries,
        0,
        rt.state.entries.length,
    );
    const laidOut = rt.transcript.scrollHeight >= contentRows - 2;
    if (
        Math.abs(rt.transcript.scrollTop - target) <= 1
        || (laidOut && target > max)
    ) {
        rt.pendingHistoryAnchor = undefined;
    }
}
