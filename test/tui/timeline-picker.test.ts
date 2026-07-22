import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    applyTuiTimelineReply,
    createTuiTimelinePickerView,
    handleTuiTimelineKey,
    startTuiTimelinePicker,
    type TuiTimelinePickerState,
} from "../../clients/tui/timeline-picker.ts";

async function timelineFrame(
    state: TuiTimelinePickerState,
    width = 80,
    height = 24,
): Promise<string> {
    const setup = await createTestRenderer({ width, height });
    const view = createTuiTimelinePickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(state);
    try {
        await setup.flush();
        return setup.captureCharFrame();
    } finally {
        setup.renderer.destroy();
    }
}
import type {
    TimelineActionPlan,
    TimelineBoundary,
} from "../../src/engine/protocol.ts";

const firstBoundary: TimelineBoundary = {
    userMessageId: "message-1",
    timestamp: "2026-07-19T09:51:00.000Z",
    prompt: "Capture checkpoint blobs",
    position: 0,
};

const secondBoundary: TimelineBoundary = {
    userMessageId: "message-3",
    timestamp: "2026-07-19T10:42:00.000Z",
    prompt: "Add stale-file protection",
    position: 2,
};

const plan: TimelineActionPlan = {
    planId: "plan-1",
    expectedHeadId: "message-4",
    boundary: secondBoundary,
    keptMessageCount: 2,
    setAsideMessageCount: 2,
};

test("timeline picker correlates list, preview, and apply requests", () => {
    let transition = startTuiTimelinePicker("list-1");
    expect(transition.command).toEqual({
        type: "list_timeline",
        requestId: "list-1",
    });
    let state = requiredState(transition.state);

    transition = applyTuiTimelineReply(state, {
        type: "timeline",
        requestId: "stale-list",
        boundaries: [],
    }, values("unused"));
    expect(transition.state).toBe(state);

    transition = applyTuiTimelineReply(state, {
        type: "timeline",
        requestId: "list-1",
        boundaries: [firstBoundary, secondBoundary],
    }, values("unused"));
    state = requiredState(transition.state);
    expect(state).toMatchObject({
        screen: "select",
        boundaries: [secondBoundary, firstBoundary],
        selectedIndex: 0,
    });

    state = requiredState(handleTuiTimelineKey(
        state,
        key("return"),
        values("unused"),
    ).state);
    transition = handleTuiTimelineKey(state, key("1", "1"), values("preview-1"));
    expect(transition.command).toEqual({
        type: "preview_timeline_action",
        requestId: "preview-1",
        boundaryId: "message-3",
        action: "rewind_conversation",
    });
    state = requiredState(transition.state);

    transition = applyTuiTimelineReply(state, {
        type: "timeline_action_preview",
        requestId: "other-preview",
        plan,
    }, values("unused"));
    expect(transition.state).toBe(state);
    state = requiredState(applyTuiTimelineReply(state, {
        type: "timeline_action_preview",
        requestId: "preview-1",
        plan,
    }, values("unused")).state);
    expect(state.screen).toBe("confirm");

    transition = handleTuiTimelineKey(state, key("return"), values("unused"));
    expect(transition.command).toBeUndefined();
    expect(transition.state).toBe(state);

    transition = handleTuiTimelineKey(state, key("1", "1"), values("apply-1"));
    expect(transition.command).toEqual({
        type: "apply_timeline_action",
        requestId: "apply-1",
        planId: "plan-1",
    });
    state = requiredState(transition.state);
    transition = applyTuiTimelineReply(state, {
        type: "timeline_action_applied",
        requestId: "apply-1",
        planId: "plan-1",
    }, values("unused"));
    expect(transition.state).toBeUndefined();
    expect(transition.composerText).toBe("Add stale-file protection");
});

test("timeline picker searches, moves, goes back, and closes locally", async () => {
    let state = selectState();
    state = requiredState(handleTuiTimelineKey(
        state,
        key("b", "b"),
        values("unused"),
    ).state);
    expect(state).toMatchObject({ screen: "select", query: "b" });
    let frame = await timelineFrame(state);
    expect(frame).toContain("Capture checkpoint blobs");
    expect(frame).not.toContain("Add stale-file protection");

    state = requiredState(handleTuiTimelineKey(
        state,
        key("backspace"),
        values("unused"),
    ).state);
    state = requiredState(handleTuiTimelineKey(
        state,
        key("down"),
        values("unused"),
    ).state);
    expect(state).toMatchObject({ screen: "select", selectedIndex: 1 });
    frame = await timelineFrame(state);
    expect(frame).toContain("09:51");
    expect(frame).toContain("10:42");

    state = requiredState(handleTuiTimelineKey(
        state,
        key("return"),
        values("unused"),
    ).state);
    expect(state.screen).toBe("actions");
    state = requiredState(handleTuiTimelineKey(
        state,
        key("escape"),
        values("unused"),
    ).state);
    expect(state.screen).toBe("select");
    expect(handleTuiTimelineKey(
        state,
        key("escape"),
        values("unused"),
    ).state).toBeUndefined();
});

test("timeline picker cancels locally and refreshes stale plans", () => {
    const actions: TuiTimelinePickerState = {
        screen: "actions",
        boundaries: [secondBoundary, firstBoundary],
        query: "",
        selectedIndex: 0,
        selectedAction: "rewind",
    };
    expect(handleTuiTimelineKey(
        actions,
        key("2", "2"),
        values("unused"),
    )).toEqual({ handled: true });

    const selectedCancel = requiredState(handleTuiTimelineKey(
        actions,
        key("down"),
        values("unused"),
    ).state);
    expect(handleTuiTimelineKey(
        selectedCancel,
        key("return"),
        values("unused"),
    )).toEqual({ handled: true });

    const previewing = requiredState(handleTuiTimelineKey(
        actions,
        key("1", "1"),
        values("preview-1"),
    ).state);
    let transition = applyTuiTimelineReply(previewing, {
        type: "timeline_action_rejected",
        requestId: "preview-1",
        operation: "apply",
        reason: "busy",
    }, values("unused"));
    expect(transition.state).toBe(previewing);

    transition = applyTuiTimelineReply(previewing, {
        type: "timeline_action_rejected",
        requestId: "preview-1",
        operation: "preview",
        reason: "busy",
    }, values("unused"));
    expect(transition.state).toMatchObject({
        screen: "actions",
        notice: "Rewind is available when the agent is idle.",
    });

    const backedOut = requiredState(handleTuiTimelineKey(
        previewing,
        key("escape"),
        values("unused"),
    ).state);
    transition = applyTuiTimelineReply(backedOut, {
        type: "timeline_action_preview",
        requestId: "preview-1",
        plan,
    }, values("unused"));
    expect(transition.state).toBe(backedOut);

    const applying: TuiTimelinePickerState = {
        screen: "applying",
        boundaries: [secondBoundary, firstBoundary],
        query: "",
        selectedIndex: 0,
        requestId: "apply-1",
        plan,
    };
    transition = applyTuiTimelineReply(applying, {
        type: "timeline_action_applied",
        requestId: "apply-1",
        planId: "different-plan",
    }, values("unused"));
    expect(transition.state).toBe(applying);

    transition = applyTuiTimelineReply(applying, {
        type: "timeline_action_rejected",
        requestId: "apply-1",
        operation: "apply",
        reason: "session_changed",
    }, values("refresh-1"));
    expect(transition).toEqual({
        state: {
            screen: "loading",
            requestId: "refresh-1",
            notice: "The conversation changed. Refreshing the timeline.",
        },
        command: { type: "list_timeline", requestId: "refresh-1" },
        handled: true,
    });
});

test("OpenTUI renders and focuses the client-owned timeline picker", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 18,
        kittyKeyboard: true,
    });
    const view = createTuiTimelinePickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(selectState());
    view.box.focus();

    try {
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Rewind: select a point");
        expect(frame).toContain("Add stale-file protection");
        expect(frame).toContain("Workspace files and external effects will not change");
        expect(setup.renderer.currentFocusedRenderable).toBe(view.box);
        expect(view.box.zIndex).toBe(10);
        expect(view.box.screenX).toBeGreaterThan(0);

        setup.resize(42, 18);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Search");
        expect(frame).toContain("esc close");

        view.update(confirmState());
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Confirm rewind");
        expect(frame).toContain("Files         unchanged");
        expect(frame).toContain("[1] Rewind now");
    } finally {
        setup.renderer.destroy();
    }
});

function selectState(): TuiTimelinePickerState {
    return {
        screen: "select",
        boundaries: [secondBoundary, firstBoundary],
        query: "",
        selectedIndex: 0,
    };
}

function confirmState(): TuiTimelinePickerState {
    return {
        screen: "confirm",
        boundaries: [secondBoundary, firstBoundary],
        query: "",
        selectedIndex: 0,
        plan,
    };
}

function key(name: string, sequence = "") {
    return {
        name,
        sequence,
        ctrl: false,
        meta: false,
        super: false,
        hyper: false,
    };
}

function requiredState(
    state: TuiTimelinePickerState | undefined,
): TuiTimelinePickerState {
    if (state === undefined) {
        throw new Error("Expected timeline picker to remain open");
    }
    return state;
}

function values<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) {
            throw new Error("No scripted value remains");
        }
        return item;
    };
}
