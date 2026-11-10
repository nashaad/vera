import { expect, test } from "bun:test";
import { TuiAgentPaneState } from "../../clients/tui/agent-pane-state.ts";
import { maybeRequestEarlierHistory } from "../../clients/tui/main/history-paging.ts";
import { applyHistoryPage } from "../../clients/tui/state.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { HistoryPageRequestError } from "../../src/host/attached-client.ts";
import type { HistoryPageResponse } from "../../src/host/protocol.ts";

function history(pane: TuiAgentPaneState): void {
    pane.apply({
        type: "history", seq: 1,
        entries: [{ kind: "user", id: "tail", text: "tail" }],
        page: { pageVersion: 1, hasMore: true, olderBefore: "tail", headId: "tail" },
    });
}

function page(): HistoryPageResponse {
    return {
        type: "history_page", request_id: "page", before: "tail",
        entries: [{ kind: "user", id: "older", text: "older" }],
        page: { pageVersion: 1, hasMore: false, headId: "tail" },
    };
}

test("side paging keeps its anchor and shares one request until the prepend settles", async () => {
    const pane = new TuiAgentPaneState();
    history(pane);
    const response = Promise.withResolvers<HistoryPageResponse>();
    let calls = 0;
    const content = {};
    const node = {
        visible: true, parent: content,
        getLayoutNode: () => ({ getComputedLayout: () => ({ top: 6, height: 3 }) }),
    };
    const rt = {
        client: {
            supportsHostCapability: () => true,
            requestHistoryPage: () => { calls += 1; return response.promise; },
        },
        clientGeneration: 0, shuttingDown: false,
        historyPaging: pane.historyPaging,
        renderer: { terminalWidth: 100, root: { getLayoutNode: () => ({ isDirty: () => false }) } },
        sidebar: { content: {}, isShown: () => false },
        transcript: { content, scrollTop: 5, scrollHeight: 100, viewport: { height: 10 }, stickyScroll: true },
        materializedEntryStart: 0, materializedEntryEnd: 1,
        entryNodes: [node], entryNodeSources: new WeakMap(), measuredEntryRows: [], measuredEntryRowsWidth: 0,
        renderCoalescer: { request: () => undefined },
    } as unknown as TuiRuntime;
    Object.defineProperty(rt, "state", {
        get: () => pane.state,
        set: (state) => { pane.state = state; },
    });
    expect(maybeRequestEarlierHistory(rt)).toBe(true);
    expect(maybeRequestEarlierHistory(rt)).toBe(false);
    expect(calls).toBe(1);
    expect(pane.historyPaging.anchor).toEqual({ entryId: "tail", offset: 1 });
    rt.entryNodes[1] = node as never;
    rt.materializedEntryEnd = 2;
    response.resolve(page());
    await response.promise;
    await Promise.resolve();
    expect(pane.historyPaging.anchor).toEqual({ entryId: "tail", offset: 1 });
    expect(pane.state.historyWindow?.entries.map((entry) => entry.id)).toEqual(["older", "tail"]);
    expect(pane.historyPaging.request).toBeUndefined();
});

test("a reattached side pane retains a loaded prefix once and keeps its paging state separate", () => {
    const pane = new TuiAgentPaneState();
    const other = new TuiAgentPaneState();
    history(pane);
    pane.state = applyHistoryPage(pane.state, page());
    pane.historyPaging.needsScroll = true;
    history(pane);
    expect(pane.state.historyWindow?.entries.map((entry) => entry.id)).toEqual(["older", "tail"]);
    expect(pane.historyPaging.needsScroll).toBe(false);
    expect(other.historyPaging).not.toBe(pane.historyPaging);
});

test("reattach rejects a stale page and requests from the new latest page", async () => {
    const pane = new TuiAgentPaneState();
    history(pane);
    const responses: ReturnType<typeof Promise.withResolvers<HistoryPageResponse>>[] = [];
    const requested: string[] = [];
    const rt = {
        client: {
            supportsHostCapability: () => true,
            requestHistoryPage: (before: string) => {
                requested.push(before);
                const response = Promise.withResolvers<HistoryPageResponse>();
                responses.push(response);
                return response.promise;
            },
        },
        clientGeneration: 0, shuttingDown: false, historyPaging: pane.historyPaging,
        renderer: { root: { getLayoutNode: () => ({ isDirty: () => false }) } },
        transcript: { scrollTop: 0, scrollHeight: 0, viewport: { height: 0 } },
        materializedEntryStart: 0, materializedEntryEnd: 0, entryNodes: [],
        renderCoalescer: { request: () => undefined },
    } as unknown as TuiRuntime;
    Object.defineProperty(rt, "state", {
        get: () => pane.state,
        set: (state) => { pane.state = state; },
    });
    expect(maybeRequestEarlierHistory(rt)).toBe(true);
    pane.apply({
        type: "history", seq: 2,
        entries: [{ kind: "user", id: "new-tail", text: "new tail" }],
        page: { pageVersion: 1, hasMore: true, olderBefore: "new-tail" },
    });
    expect(maybeRequestEarlierHistory(rt)).toBe(true);
    expect(requested).toEqual(["tail", "new-tail"]);
    responses[0]!.resolve(page());
    await responses[0]!.promise;
    await Promise.resolve();
    expect(pane.state.historyWindow?.entries.map((entry) => entry.id)).toEqual(["new-tail"]);
    responses[1]!.resolve({
        type: "history_page", request_id: "new-page", before: "new-tail",
        entries: [{ kind: "user", id: "older", text: "older" }],
        page: { pageVersion: 1, hasMore: false },
    });
    await responses[1]!.promise;
    await Promise.resolve();
    expect(pane.state.historyWindow?.entries.map((entry) => entry.id)).toEqual(["older", "new-tail"]);
});

test("a failed side page waits for the same retry window", async () => {
    const pane = new TuiAgentPaneState();
    history(pane);
    let calls = 0;
    const rt = {
        client: {
            supportsHostCapability: () => true,
            requestHistoryPage: () => {
                calls += 1;
                return Promise.reject(new HistoryPageRequestError("unavailable"));
            },
        },
        clientGeneration: 0, shuttingDown: false, historyPaging: pane.historyPaging,
        renderer: { root: { getLayoutNode: () => ({ isDirty: () => false }) } },
        transcript: { scrollTop: 0, scrollHeight: 0, viewport: { height: 0 } },
        materializedEntryStart: 0, materializedEntryEnd: 0, entryNodes: [],
        renderCoalescer: { request: () => undefined },
    } as unknown as TuiRuntime;
    Object.defineProperty(rt, "state", {
        get: () => pane.state,
        set: (state) => { pane.state = state; },
    });
    const started = Date.now();
    expect(maybeRequestEarlierHistory(rt)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(pane.state.earlierHistory).toBe("failed");
    expect(pane.historyPaging.retryAt).toBeGreaterThanOrEqual(started + 1_000);
    expect(maybeRequestEarlierHistory(rt)).toBe(false);
    pane.historyPaging.retryAt = Date.now() - 1;
    expect(maybeRequestEarlierHistory(rt)).toBe(true);
    expect(calls).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
});
