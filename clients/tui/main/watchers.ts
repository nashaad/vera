import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import type { BackgroundAgentsSnapshot } from "../../../src/host/background-agents.ts";
import type { WorkIndexSnapshot } from "../../../src/host/work-index.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { attentionNotice, attentionNoticeSequence, newAttentionRows } from "../attention-notice.ts";
import { DEFAULT_ACTIVITY_FRAME_INTERVAL_MS, SHIMMER_FRAME_INTERVAL_MS, SYMMETRIC_WAVE_FRAME_INTERVAL_MS } from "../main.ts";
import { renderState } from "../main/render-state.ts";
import { renderStatus } from "../main/render-status.ts";
import { refreshWorkspaceSidebarRoster } from "../main/workspace-ops.ts";
import { appendTuiThought, dropTuiThinking } from "../state.ts";
import { applyWorkIndex } from "../work-tab.ts";
import { applyWorkspaceWorkIndex } from "../workspace-sidebar.ts";
import type { TuiRuntime } from "./runtime.ts";

export function watchBackgroundAgents(rt: TuiRuntime, next: TuiAgentClient): void {
    rt.stopWatchingBackgroundAgents?.();
    rt.stopWatchingBackgroundAgents = undefined;
    applyBackgroundAgents(rt, next.backgroundAgents);
    rt.stopWatchingBackgroundAgents = next.onBackgroundAgents?.((agents) => {
        if (rt.client !== next || rt.shuttingDown) {
            return;
        }
        applyBackgroundAgents(rt, agents);
        renderStatus(rt);
    });
}

export function watchWorkIndex(rt: TuiRuntime, next: TuiAgentClient): void {
    rt.stopWatchingWorkIndex?.();
    rt.stopWatchingWorkIndex = undefined;
    applyWorkIndexSnapshot(rt, next.workIndex, false);
    rt.stopWatchingWorkIndex = next.onWorkIndex?.((index) => {
        if (rt.client !== next || rt.shuttingDown) return;
        applyWorkIndexSnapshot(rt, index, true);
    });
}

export function applyWorkIndexSnapshot(rt: TuiRuntime, 
    index: WorkIndexSnapshot | undefined,
    announce: boolean,
): void {
    if (index === undefined) return;
    const previous = rt.workIndex;
    rt.workIndex = index;
    if (rt.workTab !== undefined) {
        rt.workTab = applyWorkIndex(rt.workTab, index);
    }
    if (rt.workspaceSidebar !== undefined) {
        rt.workspaceSidebar = applyWorkspaceWorkIndex(rt.workspaceSidebar, index);
        refreshWorkspaceSidebarRoster(rt);
    }
    if (announce) {
        const notice = attentionNotice(
            newAttentionRows(previous, index),
            rt.terminalFocused,
        );
        if (notice !== undefined) {
            writeTerminal(rt, attentionNoticeSequence(notice));
        }
    }
    renderState(rt);
}

export function writeTerminal(rt: TuiRuntime, sequence: string): void {
    try {
        process.stdout.write(sequence);
    } catch {
    }
}

export function applyBackgroundAgents(rt: TuiRuntime, 
    agents: BackgroundAgentsSnapshot | undefined,
): void {
    rt.runningBackgroundAgents = agents?.running ?? 0;
    rt.runningBackgroundAgentNames = [...new Set(agents?.children ?? [])];
    rt.currentAgentHasParent = agents?.has_parent ?? false;
}

export function observeActivity(rt: TuiRuntime, update: AgentUpdate): void {
    emitExperimentalAgentEvent(rt, update);
    if (update.type === "status" && update.state === "working") {
        // Only a delivery turn sends this; the previous turn's start can still be set.
        rt.workingSince = Date.now();
        rt.phaseSince = rt.workingSince;
        rt.quietSince = rt.phaseSince;
        rt.activity = "thinking";
    } else if (update.type === "status" && update.state === "waiting") {
        rt.workingSince ??= Date.now();
        rt.phaseSince = undefined;
        rt.quietSince = undefined;
        rt.activity = "waiting";
        rt.reasoning = false;
    } else if (update.type === "status" && update.state === "idle") {
        rt.workingSince = undefined;
        rt.phaseSince = undefined;
        rt.quietSince = undefined;
        rt.activity = "ready";
        rt.reasoning = false;
    } else if (update.type === "model_activity") {
        rt.workingSince ??= Date.now();
        if (update.replacesPartialAttempt === true) {
            rt.phaseSince = undefined;
        }
        rt.quietSince = Date.now();
        rt.activity = `retrying ${update.model}`;
        rt.reasoning = false;
    } else if (update.type === "user_prompt") {
        rt.workingSince ??= Date.now();
        rt.phaseSince = Date.now();
        rt.quietSince = rt.phaseSince;
        rt.activity = "thinking";
        rt.reasoning = false;
    } else if (update.type === "assistant_thinking") {
        rt.workingSince ??= Date.now();
        rt.phaseSince ??= Date.now();
        rt.activity = "thinking";
        rt.reasoning = true;
    } else if (update.type === "assistant_delta") {
        finishThoughtPhase(rt);
        rt.workingSince ??= Date.now();
        rt.activity = "responding";
        rt.reasoning = false;
    } else if (update.type === "tool_started") {
        finishThoughtPhase(rt);
        rt.workingSince ??= Date.now();
        rt.activity = `running ${update.tool}`;
        rt.reasoning = false;
    } else if (update.type === "tool_finished") {
        rt.activity = "thinking";
        rt.reasoning = false;
        rt.phaseSince = Date.now();
        rt.quietSince = rt.phaseSince;
    } else if (
        update.type === "turn_finished"
        || update.type === "agent_failed"
    ) {
        finishThoughtPhase(rt);
    }
}

export function finishThoughtPhase(rt: TuiRuntime): void {
    if (rt.activity !== "thinking" || rt.phaseSince === undefined) {
        rt.state = dropTuiThinking(rt.state);
        return;
    }
    const seconds = Math.max(0, Date.now() - rt.phaseSince) / 1_000;
    rt.state = appendTuiThought(rt.state, seconds);
    rt.phaseSince = undefined;
}

export function elapsedWorkingTime(rt: TuiRuntime): string {
    if (rt.workingSince === undefined) {
        return "0s";
    }
    const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - rt.workingSince) / 1_000),
    );
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return minutes === 0
        ? `${seconds}s`
        : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function activityFrame(rt: TuiRuntime): number {
    const interval = rt.activityAnimationInterval
        ?? (rt.activityAnimation === "shimmer"
            ? SHIMMER_FRAME_INTERVAL_MS
            : rt.activityAnimation === "symmetric_wave"
            ? SYMMETRIC_WAVE_FRAME_INTERVAL_MS
            : DEFAULT_ACTIVITY_FRAME_INTERVAL_MS);
    return Math.floor(Date.now() / interval);
}

export function emitExperimentalAgentEvent(rt: TuiRuntime, update: AgentUpdate): void {
    switch (update.type) {
        case "user_prompt":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                text: update.content,
            });
            return;
        case "assistant_delta":
        case "assistant_thinking":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                text: update.text,
            });
            return;
        case "tool_started":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                tool: update.tool,
            });
            return;
        case "tool_finished":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                tool: update.tool,
                ...(update.output === undefined
                    ? {}
                    : { output: update.output.slice(0, 4_000) }),
                ...(update.isError === undefined
                    ? {}
                    : { isError: update.isError }),
            });
            return;
        case "tool_presentation":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                tool: update.tool,
            });
            return;
        case "turn_finished":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                ...(update.error === undefined
                    ? {}
                    : { text: update.error }),
            });
            return;
        case "status":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                state: update.state === "working"
                    ? "working"
                    : update.state === "waiting" ? "waiting" : "idle",
            });
            return;
        case "agent_failed":
            rt.experimentalTuiHost.agentEvent({
                type: update.type,
                text: update.detail.slice(0, 4_000),
            });
            return;
        default:
            return;
    }
}
