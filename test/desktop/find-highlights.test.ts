import { expect, test } from "bun:test";

import { scrollFindMatch } from "../../clients/ui/src/find/highlights.ts";

interface Rectangle {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

function fixture(match: Rectangle) {
    const bounds = { top: 100, bottom: 350, left: 200, right: 500 };
    let shown = 0;
    const container = {
        parentElement: null,
        clientHeight: 250,
        clientWidth: 300,
        clientTop: 0,
        clientLeft: 0,
        scrollHeight: 2000,
        scrollWidth: 1200,
        scrollTop: 0,
        scrollLeft: 0,
        getBoundingClientRect: () => bounds,
        scrollTo(options: { top: number; left: number }) {
            const dy = options.top - this.scrollTop;
            const dx = options.left - this.scrollLeft;
            this.scrollTop = options.top;
            this.scrollLeft = options.left;
            match.top -= dy;
            match.bottom -= dy;
            match.left -= dx;
            match.right -= dx;
        },
    };
    const element = {
        parentElement: container,
        scrollHeight: 10,
        clientHeight: 10,
        scrollWidth: 10,
        clientWidth: 10,
        scrollIntoView() { shown++; },
    };
    const range = {
        startContainer: { nodeType: 3, parentElement: element },
        getClientRects: () => [match],
        getBoundingClientRect: () => match,
    };
    return { range: range as unknown as Range, container, match, shown: () => shown };
}

test("find scrolls the matched range within a tall and wide element", () => {
    const { range, container, match, shown } = fixture({ top: 1100, bottom: 1120, left: 800, right: 860 });
    scrollFindMatch(range);
    expect(shown()).toBe(1);
    expect(container.scrollTop).toBe(770);
    expect(container.scrollLeft).toBe(360);
    expect(match).toEqual({ top: 330, bottom: 350, left: 440, right: 500 });
});

test("find scrolls both shadow and host ancestors for a range", () => {
    const match = { top: 900, bottom: 920, left: 20, right: 60 };
    const outer = {
        parentElement: null, parentNode: null, assignedSlot: null,
        scrollHeight: 1000, clientHeight: 200, scrollWidth: 100, clientWidth: 100,
        clientTop: 0, clientLeft: 0, scrollTop: 0, scrollLeft: 0,
        getBoundingClientRect: () => ({ top: 0, bottom: 200, left: 0, right: 100 }),
        scrollTo(options: { top: number; left: number }) {
            const dy = options.top - this.scrollTop;
            this.scrollTop = options.top;
            match.top -= dy;
            match.bottom -= dy;
        },
    };
    const inner = {
        parentElement: null, parentNode: { nodeType: 11, host: outer }, assignedSlot: null,
        scrollHeight: 1000, clientHeight: 100, scrollWidth: 100, clientWidth: 100,
        clientTop: 0, clientLeft: 0, scrollTop: 0, scrollLeft: 0,
        getBoundingClientRect: () => ({ top: 400, bottom: 500, left: 0, right: 100 }),
        scrollTo(options: { top: number; left: number }) {
            const dy = options.top - this.scrollTop;
            this.scrollTop = options.top;
            match.top -= dy;
            match.bottom -= dy;
        },
    };
    const element = {
        parentElement: inner, assignedSlot: null,
        scrollHeight: 10, clientHeight: 10, scrollWidth: 10, clientWidth: 10,
        scrollIntoView() {},
    };
    const range = {
        startContainer: { nodeType: 3, parentElement: element },
        getClientRects: () => [match], getBoundingClientRect: () => match,
    } as unknown as Range;
    scrollFindMatch(range);
    expect(inner.scrollTop).toBe(420);
    expect(outer.scrollTop).toBe(300);
    expect(match.bottom).toBe(200);
});

test("find leaves a visible range at its current scroll position", () => {
    const { range, container } = fixture({ top: 150, bottom: 170, left: 240, right: 300 });
    scrollFindMatch(range);
    expect(container.scrollTop).toBe(0);
    expect(container.scrollLeft).toBe(0);
});
