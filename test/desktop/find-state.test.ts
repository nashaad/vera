import { describe, expect, test } from "bun:test";

import { FindState, type FindCount, type FindResult, type FindTarget } from "../../clients/desktop/src/find/state.ts";

class FakeFindTarget implements FindTarget {
    readonly calls: { text: string; forward: boolean; findNext: boolean }[] = [];
    stops = 0;
    nextRequestId = 0;

    findInPage(text: string, options: { readonly forward: boolean; readonly findNext: boolean }): number {
        this.calls.push({ text, ...options });
        return ++this.nextRequestId;
    }

    stopFindInPage(action: "clearSelection"): void {
        expect(action).toBe("clearSelection");
        this.stops += 1;
    }
}

function result(requestId: number, current: number, total: number, finalUpdate = true): FindResult {
    return { requestId, activeMatchOrdinal: current, matches: total, finalUpdate };
}

describe("desktop find state", () => {
    test("@core counts current results and clears on close", () => {
        const target = new FakeFindTarget();
        const counts: FindCount[] = [];
        const state = new FindState(target, (count) => counts.push(count));
        state.search("needle");
        expect(target.calls).toEqual([{ text: "needle", forward: true, findNext: true }]);
        state.found(result(1, 1, 3, false));
        state.found(result(1, 2, 3));
        expect(counts).toEqual([{ current: 0, total: 0 }, { current: 2, total: 3 }]);
        state.clear();
        expect(target.stops).toBe(1);
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        state.found(result(1, 3, 3));
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        state.move(true);
        expect(target.calls).toHaveLength(1);
    });

    test("find follows native next and previous wrapping", () => {
        const target = new FakeFindTarget();
        const counts: FindCount[] = [];
        const state = new FindState(target, (count) => counts.push(count));
        state.search("needle");
        state.found(result(1, 2, 2));
        state.move(true);
        state.found(result(2, 1, 2));
        expect(counts.at(-1)).toEqual({ current: 1, total: 2 });
        state.move(false);
        state.found(result(3, 2, 2));
        expect(counts.at(-1)).toEqual({ current: 2, total: 2 });
        expect(target.calls.slice(1)).toEqual([
            { text: "needle", forward: true, findNext: false },
            { text: "needle", forward: false, findNext: false },
        ]);
    });

    test("find ignores stale results and clears an empty or unmatched query", () => {
        const target = new FakeFindTarget();
        const counts: FindCount[] = [];
        const state = new FindState(target, (count) => counts.push(count));
        state.search("old");
        state.search("new");
        state.found(result(1, 1, 8));
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        state.found(result(2, 0, 0));
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        state.search("");
        expect(target.stops).toBe(1);
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
    });
});

