import type {
    AgentUpdate,
    UiRequestUpdate,
} from "../../src/engine/protocol.ts";
import type { BackgroundAgentsSnapshot } from "../../src/host/background-agents.ts";
import {
    appendTuiThought,
    applyAgentUpdate,
    createTuiState,
    dropTuiThinking,
    type TuiState,
} from "./state.ts";
import { applyTuiUiRequestUpdate } from "./ui-request-queue.ts";

/** Session-owned presentation state for one attached agent pane. */
export class TuiAgentPaneState {
    state: TuiState = createTuiState();
    pendingUiRequest: UiRequestUpdate | undefined;
    readonly queuedUiRequests: UiRequestUpdate[] = [];
    backgroundAgents: BackgroundAgentsSnapshot | undefined;
    workingSince: number | undefined;
    phaseSince: number | undefined;
    activity = "thinking";
    abortRequested = false;

    apply(update: AgentUpdate, now: number = Date.now()): void {
        this.observeActivity(update, now);
        this.pendingUiRequest = applyTuiUiRequestUpdate(
            this.pendingUiRequest,
            this.queuedUiRequests,
            update,
        );
        this.state = applyAgentUpdate(this.state, update);
        if (
            update.type === "compaction"
            && update.phase === "finished"
            && update.outcome !== "busy"
            // The turn took this compaction down with it and is still
            // unwinding, so the stop the user asked for has not landed yet.
            && update.stoppedWithTurn !== true
        ) {
            this.abortRequested = false;
        }
        if (
            update.type === "turn_finished"
            || update.type === "agent_failed"
            || (update.type === "status" && update.state === "idle")
            // On the wire, user_prompt is turn_started. That follow-up is a
            // new abort target; the latch must not still name the stopped turn.
            || update.type === "user_prompt"
        ) {
            this.abortRequested = false;
        }
    }

    setBackgroundAgents(agents: BackgroundAgentsSnapshot): void {
        this.backgroundAgents = {
            running: agents.running,
            children: [...agents.children],
            has_parent: agents.has_parent,
        };
    }

    elapsedWorkingTime(now: number = Date.now()): string {
        if (this.workingSince === undefined) {
            return "0s";
        }
        const elapsedSeconds = Math.max(
            0,
            Math.floor((now - this.workingSince) / 1_000),
        );
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        return minutes === 0
            ? `${seconds}s`
            : `${minutes}m${String(seconds).padStart(2, "0")}s`;
    }

    private observeActivity(update: AgentUpdate, now: number): void {
        if (update.type === "status" && update.state === "working") {
            this.workingSince ??= now;
            this.phaseSince ??= this.workingSince;
            this.activity = "thinking";
        } else if (update.type === "status" && update.state === "waiting") {
            this.workingSince ??= now;
            this.phaseSince = undefined;
            this.activity = "waiting";
        } else if (update.type === "status" && update.state === "idle") {
            this.workingSince = undefined;
            this.phaseSince = undefined;
            this.activity = "ready";
        } else if (update.type === "model_activity") {
            this.workingSince ??= now;
            if (update.replacesPartialAttempt === true) {
                this.phaseSince = undefined;
            }
            this.activity = `retrying ${update.model}`;
        } else if (update.type === "user_prompt") {
            this.workingSince ??= now;
            this.phaseSince = now;
            this.activity = "thinking";
        } else if (update.type === "assistant_thinking") {
            this.workingSince ??= now;
            this.phaseSince ??= now;
            this.activity = "thinking";
        } else if (update.type === "assistant_delta") {
            this.finishThoughtPhase(now);
            this.workingSince ??= now;
            this.activity = "responding";
        } else if (update.type === "tool_started") {
            this.finishThoughtPhase(now);
            this.workingSince ??= now;
            this.activity = `running ${update.tool}`;
        } else if (update.type === "tool_finished") {
            this.activity = "thinking";
            this.phaseSince = now;
        } else if (
            update.type === "turn_finished"
            || update.type === "agent_failed"
        ) {
            this.finishThoughtPhase(now);
        }
    }

    private finishThoughtPhase(now: number): void {
        if (this.activity !== "thinking" || this.phaseSince === undefined) {
            this.state = dropTuiThinking(this.state);
            return;
        }
        const seconds = Math.max(0, now - this.phaseSince) / 1_000;
        this.state = appendTuiThought(this.state, seconds);
        this.phaseSince = undefined;
    }
}
