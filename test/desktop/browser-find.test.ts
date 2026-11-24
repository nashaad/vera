import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";

import { BrowserFind } from "../../clients/desktop/src/find/browser-find.ts";
import type { FindCount } from "../../clients/desktop/src/find/state.ts";

class FakeContents extends EventEmitter {
    readonly calls: { text: string; forward: boolean; findNext: boolean }[] = [];
    stops = 0;
    destroyed = false;
    loading = false;

    isDestroyed(): boolean { return this.destroyed; }
    isLoadingMainFrame(): boolean { return this.loading; }
    findInPage(text: string, options: { forward: boolean; findNext: boolean }): number {
        this.calls.push({ text, ...options });
        return this.calls.length;
    }
    stopFindInPage(): void {
        if (this.destroyed) throw new Error("destroyed target");
        this.stops++;
    }
    asContents(): WebContents { return this as unknown as WebContents; }
    result(id: number, current: number, total: number): void {
        this.emit("found-in-page", {}, { requestId: id, activeMatchOrdinal: current, matches: total, finalUpdate: true });
    }
    navigate(inPlace: boolean, mainFrame = true): void {
        this.emit("did-start-navigation", {}, "https://example.test/", inPlace, mainFrame);
    }
}

describe("browser find controller", () => {
    test("switches targets and rejects captured callbacks with colliding request IDs", () => {
        const counts: FindCount[] = [];
        const find = new BrowserFind((count) => counts.push(count));
        const first = new FakeContents();
        const second = new FakeContents();
        find.setTarget(first.asContents());
        find.search("crow");
        first.result(1, 1, 2);
        const stale = first.listeners("found-in-page")[0]!;
        find.setTarget(second.asContents());
        expect(first.stops).toBe(1);
        expect(first.eventNames()).toEqual([]);
        expect(second.calls[0]?.text).toBe("crow");
        stale({}, { requestId: 1, activeMatchOrdinal: 2, matches: 9, finalUpdate: true });
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        second.result(1, 1, 3);
        expect(counts.at(-1)).toEqual({ current: 1, total: 3 });
        find.move(false);
        expect(second.calls.at(-1)).toEqual({ text: "crow", forward: false, findNext: false });
        find.setTarget(undefined);
        expect(second.stops).toBe(1);
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        const third = new FakeContents();
        find.setTarget(third.asContents());
        expect(third.calls[0]?.text).toBe("crow");
    });

    test("clears on full navigation and searches after load, including changed query", () => {
        const counts: FindCount[] = [];
        const find = new BrowserFind((count) => counts.push(count));
        const target = new FakeContents();
        find.setTarget(target.asContents());
        find.search("crow");
        target.result(1, 1, 4);
        target.navigate(false, false);
        expect(target.stops).toBe(0);
        target.navigate(false);
        expect(target.stops).toBe(1);
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        target.result(1, 2, 4);
        find.search("raven");
        find.move(true);
        expect(target.calls).toHaveLength(1);
        target.emit("did-finish-load");
        expect(target.calls.at(-1)?.text).toBe("raven");
        target.result(2, 1, 2);
        expect(counts.at(-1)).toEqual({ current: 1, total: 2 });
        target.navigate(true);
        expect(target.calls.at(-1)?.text).toBe("raven");
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
    });

    test("waits for an already loading tab and searches after loading stops", () => {
        const counts: FindCount[] = [];
        const find = new BrowserFind((count) => counts.push(count));
        const target = new FakeContents();
        target.loading = true;
        find.setTarget(target.asContents());
        find.search("crow");
        expect(target.calls).toHaveLength(0);
        target.emit("did-stop-loading");
        expect(target.calls.at(-1)?.text).toBe("crow");
        target.emit("did-finish-load");
        expect(target.calls).toHaveLength(1);
        find.close();
    });

    test("close detaches listeners and destruction never calls a dead target", () => {
        const counts: FindCount[] = [];
        const find = new BrowserFind((count) => counts.push(count));
        const first = new FakeContents();
        find.setTarget(first.asContents());
        find.search("crow");
        const stale = first.listeners("found-in-page")[0]!;
        find.close();
        expect(first.stops).toBe(1);
        expect(first.eventNames()).toEqual([]);
        stale({}, { requestId: 1, activeMatchOrdinal: 1, matches: 4, finalUpdate: true });
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        const second = new FakeContents();
        find.setTarget(second.asContents());
        expect(second.calls).toHaveLength(0);
        find.search("raven");
        second.destroyed = true;
        second.emit("destroyed");
        expect(second.eventNames()).toEqual([]);
        expect(counts.at(-1)).toEqual({ current: 0, total: 0 });
        find.close();
        expect(second.stops).toBe(0);
    });
});
