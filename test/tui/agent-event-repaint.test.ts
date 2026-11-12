import { expect, test } from "bun:test";

import { receiveAgentUpdates } from "../../clients/tui/main/agent-updates.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import {
    createTuiExperimentalEventBus,
    type TuiExperimentalEventBus,
} from "../../clients/tui/experimental-tui-events.ts";
import { createRenderCoalescer } from "../../clients/tui/render-coalescer.ts";
import { createTuiState } from "../../clients/tui/state.ts";
import { EMPTY_TURN_METER } from "../../clients/tui/turn-meter.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

interface RenderSnapshot {
    readonly working: boolean;
    readonly entries: number;
    readonly notices: readonly string[];
}

interface Harness {
    readonly rt: TuiRuntime;
    readonly bus: TuiExperimentalEventBus;
    readonly renders: readonly RenderSnapshot[];
    readonly notices: string[];
    readonly tick: () => void;
    readonly hasPendingTimer: () => boolean;
    readonly drained: Promise<void>;
    readonly settleAsync: () => Promise<void>;
}

// The loop reads updates in order and then waits forever, so the queue's last
// read marks every update as processed.
function harness(updates: readonly AgentUpdate[]): Harness {
    const renders: RenderSnapshot[] = [];
    const notices: string[] = [];
    let pendingTimer: (() => void) | undefined;
    let drainedResolve: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
        drainedResolve = resolve;
    });
    let runtime: TuiRuntime;

    const coalescer = createRenderCoalescer({
        render: () => {
            renders.push({
                working: runtime.state.working,
                entries: runtime.state.entries.length,
                notices: [...notices],
            });
            // renderState reports the transcript to extensions on every frame.
            bus.transcriptChanged([]);
        },
        setTimer: (run) => {
            pendingTimer = run;
            return 1;
        },
        clearTimer: () => {
            pendingTimer = undefined;
        },
    });
    const bus = createTuiExperimentalEventBus(
        () => {},
        (updateType) => coalescer.request(updateType),
    );

    const queue = [...updates];
    let emptyDrained = false;
    const client = {
        receive: () => {
            const next = queue.shift();
            if (next !== undefined) return Promise.resolve(next);
            if (!emptyDrained) {
                emptyDrained = true;
                drainedResolve();
            }
            return new Promise<AgentUpdate>(() => {});
        },
        send: () => Promise.resolve(),
        supportsHostCapability: () => false,
    };

    runtime = {
        clientGeneration: 1,
        client,
        shuttingDown: false,
        state: createTuiState(),
        activity: "ready",
        reasoning: false,
        workingSince: undefined,
        phaseSince: undefined,
        quietSince: undefined,
        turnMeter: EMPTY_TURN_METER,
        entryNodes: [],
        renderCoalescer: coalescer,
        experimentalTuiHost: {
            agentEvent: (event: { readonly type: string }) => bus.agentEvent(event as never),
            hasModal: () => false,
        },
        clientExtensionRegistry: undefined,
        sessionSwitchPending: undefined,
        sessionSwitchOperation: undefined,
        sessionSwitchClearingMain: undefined,
        hostReconnectProbeId: undefined,
        hostReconnectAttempted: false,
        hostReconnectProbe: undefined,
        verificationConsole: undefined,
        pendingQueueRecall: undefined,
        pendingUiRequest: undefined,
        timelinePicker: undefined,
        abortRequested: false,
        settingsSnapshotRetries: new Map(),
        MAX_SETTINGS_SNAPSHOT_RETRIES: 3,
        pendingSkillInvocations: new Map(),
        pendingExtensionSettings: new Map(),
        requestedModelChanges: new Map(),
        promptSubmitting: false,
        disposeSkillCommands: () => {},
        composer: { plainText: "", focused: true, focus() {}, blur() {} },
        sidebar: { isFocused: () => false },
        pendingImages: [],
        pendingOneshots: new Map(),
        deferredKeymapNotices: [],
    } as unknown as TuiRuntime;

    void receiveAgentUpdates(runtime);

    return {
        rt: runtime,
        bus,
        renders,
        notices,
        tick: () => {
            const run = pendingTimer;
            pendingTimer = undefined;
            run?.();
        },
        hasPendingTimer: () => pendingTimer !== undefined,
        drained,
        settleAsync: async () => {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

test("one non-coalesced agent event paints once, after the state is applied", async () => {
    const run = harness([{ type: "user_prompt", content: "hello", seq: 1 }]);
    const seenByListener: RenderSnapshot[] = [];
    run.bus.events.on("fixture", "agent_event", () => {
        seenByListener.push({
            working: run.rt.state.working,
            entries: run.rt.state.entries.length,
            notices: [...run.notices],
        });
        run.notices.push("budget reached");
    });

    await run.drained;

    expect(seenByListener).toEqual([{
        working: true,
        entries: 1,
        notices: [],
    }]);
    expect(run.renders).toHaveLength(1);
    expect(run.renders[0]).toEqual({
        working: true,
        entries: 1,
        notices: ["budget reached"],
    });
    // The listener's repaint request was folded into the update's own frame.
    expect(run.hasPendingTimer()).toBe(false);
});

test("an async listener repaints after its promise settles", async () => {
    const run = harness([{ type: "user_prompt", content: "hello", seq: 1 }]);
    let settled = false;
    run.bus.events.on("fixture", "agent_event", async () => {
        await Promise.resolve();
        settled = true;
    });

    await run.drained;
    expect(run.renders).toHaveLength(1);

    await run.settleAsync();
    expect(settled).toBe(true);
    expect(run.hasPendingTimer()).toBe(true);
    run.tick();
    expect(run.renders).toHaveLength(2);
});

test("every forwarded update type still reaches the listener", async () => {
    const updates: AgentUpdate[] = [
        { type: "user_prompt", content: "hello", seq: 1 },
        { type: "assistant_delta", text: "hi", seq: 2 },
        { type: "assistant_thinking", text: "hm", seq: 3 },
        { type: "tool_started", tool: "bash", args: {}, seq: 4 },
        { type: "tool_finished", tool: "bash", output: "ok", seq: 5 },
        {
            type: "tool_presentation",
            tool: "bash",
            presentation: { kind: "tool_notice", text: "done" },
            seq: 6,
        },
        { type: "status", state: "working", seq: 7 },
        { type: "turn_finished", seq: 8 },
        { type: "agent_failed", failureId: "failure-1", detail: "boom", seq: 9 },
    ];
    const run = harness(updates);
    const seen: string[] = [];
    run.bus.events.on("fixture", "agent_event", (event: { readonly type: string }) => {
        seen.push(event.type);
    });

    await run.drained;

    expect(seen).toEqual([
        "user_prompt",
        "assistant_delta",
        "assistant_thinking",
        "tool_started",
        "tool_finished",
        "tool_presentation",
        "status",
        "turn_finished",
        "agent_failed",
    ]);
});
