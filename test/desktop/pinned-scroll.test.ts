import { expect, test } from "bun:test";

import { PinnedScrollState } from "../../clients/ui/src/session/pinned-scroll.ts";

test("@core a revealed match keeps its position as the transcript grows", () => {
    const state = new PinnedScrollState();
    const box = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
    state.resized(box);
    expect(box.scrollTop).toBe(1000);

    box.scrollTop = 100;
    state.preservePosition(box);
    box.scrollHeight = 1200;
    state.resized(box);
    expect(box.scrollTop).toBe(100);

    box.scrollTop = 900;
    state.scrolled(box);
    box.scrollHeight = 1300;
    state.resized(box);
    expect(box.scrollTop).toBe(1300);
});

test("a revealed match within the bottom slack stays in place on resize", () => {
    const state = new PinnedScrollState();
    const box = { scrollTop: 660, scrollHeight: 1000, clientHeight: 300 };
    state.preservePosition(box);
    state.resized(box);
    expect(box.scrollTop).toBe(660);
});

test("height changes do not release an otherwise pinned transcript", () => {
    const state = new PinnedScrollState();
    const box = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
    state.scrolled(box);
    box.scrollTop = 650;
    box.scrollHeight = 1200;
    state.scrolled(box);
    state.resized(box);
    expect(box.scrollTop).toBe(1200);
});

test("scrolling up without a height change releases the pin", () => {
    const state = new PinnedScrollState();
    const box = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
    state.scrolled(box);
    box.scrollTop = 300;
    state.scrolled(box);
    box.scrollHeight = 1200;
    state.resized(box);
    expect(box.scrollTop).toBe(300);
});
