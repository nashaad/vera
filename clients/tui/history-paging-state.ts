import { HistoryPageRequestError } from "../../src/host/attached-client.ts";

export interface HistoryAnchor {
    readonly entryId: string;
    readonly offset: number;
}

export type EarlierHistoryOutcome = "loaded" | "superseded";

/** The one page request in flight. Extension callers wait on its outcome. */
export interface EarlierHistoryRequest {
    readonly generation: number;
    readonly before: string;
    readonly controller: AbortController;
    readonly deferred: PromiseWithResolvers<EarlierHistoryOutcome>;
}

export interface HistoryPaging {
    request: EarlierHistoryRequest | undefined;
    retryAt: number | undefined;
    needsScroll: boolean;
    blocked: boolean;
    anchor: (HistoryAnchor & { placed?: boolean }) | undefined;
    mainConversation: boolean;
}

export function createHistoryPaging(mainConversation = true): HistoryPaging {
    return {
        request: undefined,
        retryAt: undefined,
        needsScroll: false,
        blocked: false,
        anchor: undefined,
        mainConversation,
    };
}

export function resetHistoryPagingState(paging: HistoryPaging, sameConversation: boolean): void {
    const request = paging.request;
    paging.request = undefined;
    if (request !== undefined) {
        request.controller.abort();
        request.deferred.reject(sameConversation
            ? new HistoryPageRequestError("unavailable")
            : new DOMException("The conversation changed.", "AbortError"));
    }
    paging.retryAt = undefined;
    paging.needsScroll = false;
    paging.blocked = false;
    paging.anchor = undefined;
}
