import { expect, test } from "bun:test";

import {
    activityAnimationNow,
    animationLevelNow,
    statusTimerInterval,
    syncStatusTimer,
} from "../../clients/tui/main/animation-level.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";

const IDLE_MS = 1000;
const EFFECTS_OFF_MS = 1000;
const FAST_MS = 250;
const BLURRED_MS = 1000;

function runtime(overrides: Record<string, unknown> = {}): TuiRuntime {
    return {
        animationLevel: 1,
        activityAnimation: "shimmer",
        state: { working: false },
        hostedSidebar: {},
        runningBackgroundAgentNames: [],
        workspaceSidebar: undefined,
        resumeOverlay: { surface: { visible: false } },
        animationsPreviewOpen: false,
        settingsPicker: undefined,
        workIndex: undefined,
        ...overrides,
    } as unknown as TuiRuntime;
}

test("an idle screen ticks once a second", () => {
    expect(statusTimerInterval(runtime())).toBe(IDLE_MS);
    expect(statusTimerInterval(runtime({
        animationLevel: 0,
        activityAnimation: "off",
    }))).toBe(IDLE_MS);
});

test("a running turn ticks fast", () => {
    expect(statusTimerInterval(runtime({ state: { working: true } }))).toBe(FAST_MS);
});

test("a running turn with effects off still steps spinners at 100 ms", () => {
    expect(statusTimerInterval(runtime({
        animationLevel: 0,
        activityAnimation: "off",
        state: { working: true },
    }))).toBe(EFFECTS_OFF_MS);
});

test("compacting and hosted work keep the fast tick", () => {
    expect(statusTimerInterval(runtime({ state: { compactingSince: 1 } }))).toBe(FAST_MS);
    expect(statusTimerInterval(runtime({
        hostedSidebar: { pane: { state: { state: { working: true } } } },
    }))).toBe(FAST_MS);
});

test("background spokes follow the activity setting", () => {
    expect(statusTimerInterval(runtime({ runningBackgroundAgentNames: ["crow"] }))).toBe(FAST_MS);
    expect(statusTimerInterval(runtime({
        activityAnimation: "off",
        animationLevel: 0,
        runningBackgroundAgentNames: ["crow"],
    }))).toBe(IDLE_MS);
});

test("a working sidebar session spins at any activity setting", () => {
    expect(statusTimerInterval(runtime({
        activityAnimation: "off",
        animationLevel: 0,
        workspaceSidebar: { sessions: [{ status: "working" }] },
    }))).toBe(EFFECTS_OFF_MS);
    expect(statusTimerInterval(runtime({
        workspaceSidebar: { sessions: [{ status: "idle" }] },
    }))).toBe(IDLE_MS);
});

test("the resume overlay and the animations preview keep the fast tick", () => {
    expect(statusTimerInterval(runtime({
        activityAnimation: "off",
        animationLevel: 0,
        resumeOverlay: { surface: { visible: true } },
    }))).toBe(EFFECTS_OFF_MS);
    expect(statusTimerInterval(runtime({
        activityAnimation: "off",
        animationLevel: 0,
        animationsPreviewOpen: true,
    }))).toBe(EFFECTS_OFF_MS);
});

test("an animation starting retimes the running timer", () => {
    const rt = runtime();
    rt.statusTimer = setInterval(() => {}, 60_000);
    try {
        rt.statusTimerInterval = IDLE_MS;
        syncStatusTimer(rt);
        expect(rt.statusTimerInterval).toBe(IDLE_MS);
        rt.state = { working: true } as TuiRuntime["state"];
        syncStatusTimer(rt);
        expect(rt.statusTimerInterval).toBe(FAST_MS);
    } finally {
        clearInterval(rt.statusTimer);
    }
});

test("picker shimmer only runs with activity effects on and live work", () => {
    expect(statusTimerInterval(runtime({
        settingsPicker: { kind: "session" },
        workIndex: { working: 2 },
    }))).toBe(FAST_MS);
    expect(statusTimerInterval(runtime({
        activityAnimation: "off",
        settingsPicker: { kind: "session" },
        workIndex: { working: 2 },
    }))).toBe(IDLE_MS);
    expect(statusTimerInterval(runtime({
        settingsPicker: { kind: "model", browseFeedback: { status: "working" } },
    }))).toBe(FAST_MS);
    expect(statusTimerInterval(runtime({
        animationLevel: 0,
        activityAnimation: "off",
        settingsPicker: { kind: "model", browseFeedback: { status: "working" } },
    }))).toBe(IDLE_MS);
});

test("a blurred terminal ticks once a second and draws animations static", () => {
    const blurred = { terminalFocused: false, state: { working: true } };
    expect(statusTimerInterval(runtime(blurred))).toBe(BLURRED_MS);
    expect(statusTimerInterval(runtime({ ...blurred, workspaceSidebar: { sessions: [{ status: "working" }] } })))
        .toBe(BLURRED_MS);
    expect(animationLevelNow(runtime(blurred))).toBe(0);
    expect(activityAnimationNow(runtime(blurred))).toBe("off");
});

test("focus or a terminal that never reports focus keeps the live rate", () => {
    expect(statusTimerInterval(runtime({ terminalFocused: true, state: { working: true } }))).toBe(FAST_MS);
    expect(statusTimerInterval(runtime({ state: { working: true } }))).toBe(FAST_MS);
    expect(animationLevelNow(runtime())).toBe(1);
    expect(activityAnimationNow(runtime())).toBe("shimmer");
});
