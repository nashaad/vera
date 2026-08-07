import { expect, test } from "bun:test";

import {
    createRenderCoalescer,
    isCoalescedUpdate,
} from "../../clients/tui/render-coalescer.ts";

interface Clock {
    readonly coalescer: ReturnType<typeof createRenderCoalescer>;
    readonly renders: () => number;
    readonly tick: () => void;
}

function testClock(): Clock {
    let pending: (() => void) | undefined;
    let renders = 0;
    const coalescer = createRenderCoalescer({
        render: () => {
            renders += 1;
        },
        setTimer: (run) => {
            pending = run;
            return 1;
        },
        clearTimer: () => {
            pending = undefined;
        },
    });
    return {
        coalescer,
        renders: () => renders,
        tick: () => {
            const run = pending;
            pending = undefined;
            run?.();
        },
    };
}

test("a burst of deltas paints once", () => {
    const clock = testClock();
    for (let index = 0; index < 200; index += 1) {
        clock.coalescer.request("assistant_delta");
    }

    expect(clock.renders()).toBe(0);
    clock.tick();
    expect(clock.renders()).toBe(1);
});

test("the last delta of a burst still lands", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.tick();
    clock.coalescer.request("assistant_delta");

    // The trailing delta is waiting, and finishing the turn shows it without
    // waiting for the timer.
    expect(clock.renders()).toBe(1);
    clock.coalescer.request("turn_finished");
    expect(clock.renders()).toBe(2);
});

test("an interaction surface paints at once, with whatever was waiting", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.coalescer.request("ui_request");

    expect(clock.renders()).toBe(1);
    // The delta rode along with it, so the timer has nothing left to paint.
    clock.tick();
    expect(clock.renders()).toBe(1);
});

test("a quiet stream does not repaint", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.tick();
    clock.tick();

    expect(clock.renders()).toBe(1);
});

test("stopping drops a pending repaint", () => {
    const clock = testClock();
    clock.coalescer.request("assistant_delta");
    clock.coalescer.stop();
    clock.tick();
    clock.coalescer.flush();

    expect(clock.renders()).toBe(0);
});

test("only streaming updates are coalesced", () => {
    expect(isCoalescedUpdate("assistant_delta")).toBe(true);
    expect(isCoalescedUpdate("model_activity")).toBe(true);
    // A type nobody listed is immediate, which is the safe direction for one
    // added later.
    expect(isCoalescedUpdate("tool_started")).toBe(false);
    expect(isCoalescedUpdate("ui_request")).toBe(false);
});
