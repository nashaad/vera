import { expect, test } from "bun:test";

import {
    HISTORY_PAGE_VERSION,
    entryId,
} from "../../clients/shared/history-window.ts";
import { EMPTY_THREAD_FACTS, threadFactEntries } from "../../clients/shared/thread-facts.ts";
import { hasEarlierHistory, loadEarlierHistory } from "../../clients/tui/main/history-paging.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import {
    applyAgentUpdate,
    applyHistoryPage,
    createTuiState,
    type TuiState,
} from "../../clients/tui/state.ts";
import type { TranscriptEntry } from "../../src/engine/protocol.ts";
import { HistoryPageRequestError } from "../../src/host/attached-client.ts";
import type { HistoryPageResponse } from "../../src/host/protocol.ts";

type PageRequest = (before: string) => Promise<HistoryPageResponse>;

// The window reports older history, but this client has no paging capability.
function nonPagingRuntime(): TuiRuntime {
    return {
        client: {},
        state: { historyWindow: { entries: [], hasEarlier: true, olderBefore: "older-0" } },
        earlierHistoryRequest: undefined,
    } as unknown as TuiRuntime;
}

test("a client that cannot page reports no earlier history and loads nothing", async () => {
    const rt = nonPagingRuntime();
    expect(hasEarlierHistory(rt)).toBe(false);
    await loadEarlierHistory(rt);
    expect(rt.earlierHistoryRequest).toBeUndefined();
});

function answerEntry(id: string): TranscriptEntry {
    return { kind: "assistant", text: `answer ${id}`, id, recordedAt: 1_000 };
}

function pageResponse(
    before: string,
    entries: readonly TranscriptEntry[],
    olderBefore?: string,
): HistoryPageResponse {
    return {
        type: "history_page",
        request_id: "r",
        before,
        entries,
        page: {
            pageVersion: HISTORY_PAGE_VERSION,
            hasMore: olderBefore !== undefined,
            ...(olderBefore === undefined ? {} : { olderBefore }),
        },
    };
}

function tailState(olderBefore: string | undefined): TuiState {
    return applyAgentUpdate(createTuiState(), {
        type: "history",
        seq: 1,
        entries: [answerEntry("tail")],
        page: {
            pageVersion: HISTORY_PAGE_VERSION,
            hasMore: olderBefore !== undefined,
            ...(olderBefore === undefined ? {} : { olderBefore }),
            headId: "tail",
        },
    });
}

function pagingRuntime(requestPage: PageRequest, state: TuiState): TuiRuntime {
    return {
        clientGeneration: 0,
        conversationGeneration: 0,
        shuttingDown: false,
        client: {
            supportsHostCapability: () => true,
            requestHistoryPage: requestPage,
        },
        state,
        renderer: { root: { getLayoutNode: () => ({ isDirty: () => false }) } },
        transcript: { scrollTop: 0, scrollHeight: 0, viewport: { height: 0 } },
        materializedEntryStart: 0,
        materializedEntryEnd: 0,
        entryNodes: [],
        composer: { prependSubmittedPrompts: () => undefined },
        renderCoalescer: { request: () => undefined },
        earlierHistoryRequest: undefined,
        earlierHistoryRetryAt: undefined,
        earlierHistoryNeedsScroll: false,
        earlierHistoryBlocked: false,
        pendingHistoryAnchor: undefined,
        pendingTranscriptReseed: false,
    } as unknown as TuiRuntime;
}

function windowIds(rt: TuiRuntime): (string | undefined)[] {
    return (rt.state.historyWindow?.entries ?? []).map((entry) => entryId(entry));
}

async function rejectionOf(promise: Promise<void>): Promise<unknown> {
    return promise.then(() => undefined, (error: unknown) => error);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : "";
}

test("concurrent loadEarlier calls share one page request", async () => {
    const requested: string[] = [];
    let answer: (response: HistoryPageResponse) => void = () => undefined;
    const rt = pagingRuntime((before) => {
        requested.push(before);
        return new Promise<HistoryPageResponse>((resolve) => {
            answer = resolve;
        });
    }, tailState("older-1"));
    const first = loadEarlierHistory(rt);
    const second = loadEarlierHistory(rt);
    expect(requested).toEqual(["older-1"]);
    answer(pageResponse("older-1", [answerEntry("older")]));
    await Promise.all([first, second]);
    expect(windowIds(rt)).toEqual(["older", "tail"]);
});

test("a failed page load rejects with the request error and keeps the window", async () => {
    const state = tailState("older-1");
    const rt = pagingRuntime(async () => {
        throw new HistoryPageRequestError("unavailable");
    }, state);
    const failure = await rejectionOf(loadEarlierHistory(rt));
    expect(failure).toBeInstanceOf(HistoryPageRequestError);
    expect(messageOf(failure)).toBe("History page request failed: unavailable");
    expect(rt.state.historyWindow).toEqual(state.historyWindow);
    expect(rt.earlierHistoryRequest).toBeUndefined();
});

test("a page rejected with AbortError by a deliberate release rejects the waiting load with AbortError", async () => {
    const rt = pagingRuntime(
        () => Promise.reject(new DOMException("Agent attachment is released", "AbortError")),
        tailState("older-1"),
    );
    const failure = await rejectionOf(loadEarlierHistory(rt));
    expect((failure as Error).name).toBe("AbortError");
    expect(rt.earlierHistoryRequest).toBeUndefined();
});

test("a page that adds nothing and holds its position rejects with the no-progress error", async () => {
    const rt = pagingRuntime(
        async (before) => pageResponse(before, [], before),
        tailState("older-1"),
    );
    const failure = await rejectionOf(loadEarlierHistory(rt));
    expect(failure).toBeInstanceOf(HistoryPageRequestError);
    expect(messageOf(failure)).toBe("History page request failed: unavailable");
});

test("loadEarlier resolves at once when no older entries are left", async () => {
    const requested: string[] = [];
    const rt = pagingRuntime(async (before) => {
        requested.push(before);
        return pageResponse(before, []);
    }, tailState(undefined));
    await loadEarlierHistory(rt);
    expect(requested).toEqual([]);
});

test("a loaded older page stays in the thread facts across a tail checkpoint", () => {
    const paged = applyHistoryPage(
        tailState("older-1"),
        pageResponse("older-1", [answerEntry("older")]),
    );
    const state = applyAgentUpdate(paged, {
        type: "history",
        seq: 2,
        entries: [answerEntry("tail")],
        page: { pageVersion: HISTORY_PAGE_VERSION, hasMore: false, headId: "tail" },
    });
    expect(threadFactEntries(state.threadFacts ?? EMPTY_THREAD_FACTS)).toEqual([
        { kind: "assistant", text: "answer older", id: "older", at: 1_000 },
        { kind: "assistant", text: "answer tail", id: "tail", at: 1_000 },
    ]);
});
