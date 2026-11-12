import { expect, test } from "bun:test";

import { defaultLayout, type LayoutState } from "../../clients/ui/src/layout/model.ts";
import { createLayoutSaver } from "../../clients/ui/src/layout/persist.ts";
import { dropIndex } from "../../clients/ui/src/workbench/drag.tsx";

function layoutWith(size: number): LayoutState {
    const base = defaultLayout();
    return { ...base, locations: { ...base.locations, sidebar: { ...base.locations.sidebar, size } } };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("@core a burst of changes becomes one write of the last layout", async () => {
    const written: LayoutState[] = [];
    const saver = createLayoutSaver((layout) => written.push(layout), 20);
    saver.schedule(layoutWith(200));
    saver.schedule(layoutWith(210));
    saver.schedule(layoutWith(220));
    expect(written).toEqual([]);
    await sleep(60);
    expect(written).toEqual([layoutWith(220)]);
});

test("flush writes the pending layout at once and only once", async () => {
    const written: LayoutState[] = [];
    const saver = createLayoutSaver((layout) => written.push(layout), 20);
    saver.flush();
    expect(written).toEqual([]);
    saver.schedule(layoutWith(300));
    saver.flush();
    saver.flush();
    await sleep(50);
    expect(written).toEqual([layoutWith(300)]);
});

test("a drop index counts the entries whose midpoint the pointer has passed", () => {
    const rects = [{ start: 0, size: 100 }, { start: 100, size: 100 }, { start: 200, size: 100 }];
    expect(dropIndex(rects, 10)).toBe(0);
    expect(dropIndex(rects, 60)).toBe(1);
    expect(dropIndex(rects, 160)).toBe(2);
    expect(dropIndex(rects, 290)).toBe(3);
    expect(dropIndex([], 5)).toBe(0);
});
