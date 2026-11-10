import { resetHistoryPagingState, type EarlierHistoryOutcome, type EarlierHistoryRequest, type HistoryAnchor } from "../history-paging-state.ts";
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

type PageRequester = NonNullable<TuiRuntime["client"]["requestHistoryPage"]>;
type HistoryPage = Awaited<ReturnType<PageRequester>>;

interface NextPage {
    readonly requestPage: PageRequester;
    readonly before: string;
}

/** A reset within one conversation fails the waiting load. A new conversation rejects it with AbortError. */
export function resetHistoryPaging(rt: TuiRuntime, sameConversation: boolean): void {
    resetHistoryPagingState(rt.historyPaging, sameConversation);
}

/** The rejection a waiter gets when the conversation changes underneath it. */
export function abortError(): DOMException {
    return new DOMException("The conversation changed.", "AbortError");
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

function pageRequester(rt: TuiRuntime): PageRequester | undefined {
    if (rt.shuttingDown) return undefined;
    if (rt.client.supportsHostCapability?.(HOST_CAPABILITY_AGENT_HISTORY_PAGING) !== true) {
        return undefined;
    }
    return rt.client.requestHistoryPage;
}

function nextPage(rt: TuiRuntime): NextPage | undefined {
    const window = rt.state.historyWindow;
    if (window === undefined || !window.hasEarlier || window.olderBefore === undefined) {
        return undefined;
    }
    const requestPage = pageRequester(rt);
    if (requestPage === undefined) return undefined;
    return { requestPage, before: window.olderBefore };
}

/** True while older entries exist and this client can page them in. */
export function hasEarlierHistory(rt: TuiRuntime): boolean {
    return nextPage(rt) !== undefined;
}

function canRequest(rt: TuiRuntime, force: boolean): boolean {
    return !rt.historyPaging.blocked
        && (force || !rt.historyPaging.needsScroll)
        && rt.state.earlierHistory !== "too_large"
        && rt.historyPaging.request === undefined
        && (rt.historyPaging.retryAt === undefined
            || Date.now() >= rt.historyPaging.retryAt);
}

/** Returns true when a page request was started. */
export function maybeRequestEarlierHistory(
    rt: TuiRuntime,
    options: { readonly force?: boolean } = {},
): boolean {
    const force = options.force === true;
    const next = nextPage(rt);
    if (next === undefined || !canRequest(rt, force)) return false;
    if (!force && !withinPrefetchRange(rt)) return false;
    startEarlierHistoryRequest(rt, next);
    return true;
}

/**
 * Loads one older page for an extension caller. A caller that arrives while a
 * page is out waits on that page instead of asking again.
 */
export async function loadEarlierHistory(
    rt: TuiRuntime,
    signal?: AbortSignal,
): Promise<void> {
    const generation = rt.conversationGeneration;
    for (;;) {
        if (signal?.aborted) throw signal.reason;
        const next = nextPage(rt);
        if (next === undefined) return;
        const request = rt.historyPaging.request ?? startEarlierHistoryRequest(rt, next);
        const outcome = await awaitOutcome(request, signal);
        if (rt.conversationGeneration !== generation) throw abortError();
        if (outcome === "loaded") return;
    }
}

function awaitOutcome(
    request: EarlierHistoryRequest,
    signal: AbortSignal | undefined,
): Promise<EarlierHistoryOutcome> {
    if (signal === undefined) return request.deferred.promise;
    return new Promise((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        void request.deferred.promise.then((outcome) => {
            signal.removeEventListener("abort", onAbort);
            resolve(outcome);
        }, (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}

function startEarlierHistoryRequest(rt: TuiRuntime, next: NextPage): EarlierHistoryRequest {
    const request: EarlierHistoryRequest = {
        generation: rt.clientGeneration,
        before: next.before,
        controller: new AbortController(),
        deferred: Promise.withResolvers<EarlierHistoryOutcome>(),
    };
    // Auto requests have no waiter, so a failure must not surface as unhandled.
    request.deferred.promise.catch(() => undefined);
    rt.historyPaging.request = request;
    const previousEntries = rt.state.entries;
    // This row is inserted now, so its anchor cannot go stale while a page
    // is in flight.
    const loadingAnchor = captureHistoryAnchor(rt);
    rt.state = setEarlierHistoryStatus(rt.state, "loading");
    const loadingDelta = rt.state.entries.length - previousEntries.length;
    if (!shiftTranscriptWindowForPrepend(rt, previousEntries, loadingDelta)) {
        rt.historyPaging.anchor = loadingAnchor;
        rt.pendingTranscriptReseed = true;
    }
    rt.renderCoalescer.request("history_page");

    void next.requestPage(next.before, request.controller.signal)
        .then((response) => receiveEarlierHistoryPage(rt, request, response))
        .catch((error: unknown) => failEarlierHistoryRequest(rt, request, error));
    return request;
}

function isCurrentRequest(rt: TuiRuntime, request: EarlierHistoryRequest): boolean {
    return !rt.shuttingDown
        && request.generation === rt.clientGeneration
        && !request.controller.signal.aborted;
}

function receiveEarlierHistoryPage(
    rt: TuiRuntime,
    request: EarlierHistoryRequest,
    response: HistoryPage,
): void {
    if (!isCurrentRequest(rt, request)) {
        request.deferred.reject(abortError());
        return;
    }
    if (rt.historyPaging.request === request) rt.historyPaging.request = undefined;
    rt.historyPaging.retryAt = undefined;
    if (rt.state.historyWindow?.olderBefore !== request.before) {
        // A checkpoint moved the cursor while the page was out; drop it and
        // ask from the new cursor.
        rt.state = setEarlierHistoryStatus(rt.state, undefined);
        rt.pendingTranscriptReseed = true;
        rt.renderCoalescer.request("history_page");
        request.deferred.resolve("superseded");
        return;
    }
    rt.historyPaging.anchor = captureHistoryAnchor(rt);
    rt.historyPaging.needsScroll = true;
    const previousEntries = rt.state.entries;
    const previousWindow = rt.state.historyWindow;
    rt.state = applyHistoryPage(rt.state, response);
    const moved = historyWindowMoved(previousWindow, rt.state.historyWindow);
    if (!moved) {
        // A page that moves nothing must not be asked again on the next frame.
        rt.historyPaging.retryAt = Date.now() + EARLIER_HISTORY_RETRY_DELAY_MS;
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
    if (rt.historyPaging.mainConversation && added > 0) {
        rt.composer.prependSubmittedPrompts(historyUserPrompts(rt.state.historyWindow!.entries.slice(0, added)));
    }
    const firstText = historyWindowFirstUserText(
        rt.state.historyWindow ?? { entries: [], hasEarlier: false },
    );
    if (rt.historyPaging.mainConversation && firstText !== undefined) {
        adoptFallbackSessionTitle(rt, firstText);
    }
    rt.renderCoalescer.request("history_page");
    if (moved) {
        request.deferred.resolve("loaded");
    } else {
        request.deferred.reject(unavailableError());
    }
}

function failEarlierHistoryRequest(
    rt: TuiRuntime,
    request: EarlierHistoryRequest,
    error: unknown,
): void {
    if (!isCurrentRequest(rt, request)) {
        request.deferred.reject(abortError());
        return;
    }
    if (rt.historyPaging.request === request) rt.historyPaging.request = undefined;
    if (error instanceof HistoryPageRequestError) {
        if (error.reason === "page_too_large") {
            rt.historyPaging.blocked = true;
            rt.state = setEarlierHistoryStatus(rt.state, "too_large");
        } else {
            rt.historyPaging.retryAt = Date.now() + EARLIER_HISTORY_RETRY_DELAY_MS;
            rt.state = setEarlierHistoryStatus(rt.state, "failed");
        }
    } else {
        // The attachment went away (reconnect, detach or release). No row: the
        // next frame retries once a new attachment is ready.
        rt.historyPaging.retryAt = Date.now() + EARLIER_HISTORY_RETRY_DELAY_MS;
        rt.state = setEarlierHistoryStatus(rt.state, undefined);
    }
    rt.pendingTranscriptReseed = true;
    rt.renderCoalescer.request("history_page");
    request.deferred.reject(
        error instanceof HistoryPageRequestError || isAbortError(error)
            ? error
            : unavailableError(),
    );
}

/** Rejection for older history that cannot be loaded now. One place to change its reason. */
function unavailableError(): HistoryPageRequestError {
    return new HistoryPageRequestError("unavailable");
}

/** A deliberate release rejects with AbortError. Waiters receive it unchanged. */
function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

/**
 * The page window starts at the anchor row, so the anchor's offset from the
 * transcript top is the top spacer plus its row offset. Retry until the
 * scrollbar has the new content size.
 */
export function applyPendingHistoryScroll(rt: TuiRuntime): void {
    const anchor = rt.historyPaging.anchor;
    if (anchor === undefined || anchor.placed !== true) return;
    const index = rt.state.entries.findIndex((entry) =>
        entry.kind !== "diff" && entry.entryId === anchor.entryId
    );
    if (index === -1) {
        rt.historyPaging.anchor = undefined;
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
        rt.historyPaging.anchor = undefined;
    }
}
