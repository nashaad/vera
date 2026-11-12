import type { DesktopEvent, DesktopPhase } from "../protocol/bridge.ts";
import type { HostIdentityFacts } from "../protocol/client.ts";
import type { SessionRow } from "../protocol/sessions.ts";

export type UiPhase = DesktopPhase | "disconnected" | "failed" | "missing";

export interface ReadyFacts {
    readonly pid: number;
    readonly buildId: string | null;
    readonly home: string;
    // When this window saw the host ready, for Settings > Devices.
    readonly attachedAt: number;
}

export interface UiQuestion {
    readonly id: string;
    readonly text: string;
}

export interface UiState {
    readonly phase: UiPhase;
    readonly ready?: ReadyFacts;
    readonly identity?: HostIdentityFacts;
    readonly sessions?: number;
    // The first page of the host's listing; `sessions` is the size of the whole listing.
    readonly sessionRows?: readonly SessionRow[];
    readonly question?: UiQuestion;
    readonly failure?: string;
    readonly checked?: readonly string[];
    readonly notice?: string;
}

export type UiAction =
    | { readonly type: "event"; readonly event: DesktopEvent }
    | { readonly type: "identity"; readonly identity: HostIdentityFacts }
    | {
        readonly type: "sessions";
        readonly count: number | undefined;
        readonly rows: readonly SessionRow[];
    }
    | { readonly type: "notice"; readonly message: string }
    | { readonly type: "lost"; readonly reason: string }
    | { readonly type: "reconnecting" }
    | { readonly type: "answered" };

export const INITIAL_STATE: UiState = { phase: "starting" };

export function reduceConnection(state: UiState, action: UiAction): UiState {
    switch (action.type) {
        case "event":
            return reduceEvent(state, action.event);
        case "identity":
            return { ...state, identity: action.identity, notice: undefined };
        case "sessions":
            return { ...state, sessions: action.count, sessionRows: action.rows, notice: undefined };
        case "notice":
            return { ...state, notice: action.message };
        case "lost":
            return lost(state, action.reason);
        case "reconnecting":
            return { phase: "starting", ready: state.ready };
        case "answered":
            return { ...state, question: undefined };
    }
}

function reduceEvent(state: UiState, event: DesktopEvent): UiState {
    switch (event.type) {
        case "phase":
            return { ...state, phase: event.phase };
        case "question":
            return { ...state, question: { id: event.id, text: event.text } };
        case "ready":
            return {
                phase: "attached",
                ready: { pid: event.pid, buildId: event.buildId, home: event.home, attachedAt: Date.now() },
            };
        case "missing_cli":
            return {
                phase: "missing",
                ready: state.ready,
                failure: event.message,
                checked: event.checked,
            };
        case "failed":
            return { phase: "failed", ready: state.ready, failure: event.message };
        case "disconnected":
            return lost(state, event.reason);
        case "frame":
        case "session_frame":
        case "session_closed":
        case "command":
            return state;
    }
}

// The last host facts stay for the sidebar footer; the live ones are dropped with the connection.
function lost(state: UiState, reason: string): UiState {
    if (state.phase === "disconnected") return state;
    return { phase: "disconnected", ready: state.ready, failure: reason };
}

export type Tone = "success" | "info" | "warning" | "danger";

export type BannerState =
    | {
        readonly kind: "question";
        readonly tone: Tone;
        readonly questionId: string;
        readonly title: string;
        readonly detail: string;
    }
    | {
        readonly kind: "failed" | "missing" | "disconnected";
        readonly tone: Tone;
        readonly title: string;
        readonly detail: string;
    };

// The right pane is closed by default, so the banner itself names the paths that were checked.
function missingDetail(state: UiState): string {
    const reason = state.failure ?? "Vera is not installed.";
    return state.checked !== undefined && state.checked.length > 0
        ? `${reason} Checked: ${state.checked.join(", ")}`
        : reason;
}

export function bannerFor(state: UiState): BannerState | undefined {
    if (state.question !== undefined) {
        return {
            kind: "question",
            tone: "info",
            questionId: state.question.id,
            title: "Vera needs an answer",
            detail: state.question.text,
        };
    }
    if (state.phase === "missing") {
        return {
            kind: "missing",
            tone: "danger",
            title: "Vera is not installed",
            detail: missingDetail(state),
        };
    }
    if (state.phase === "failed") {
        return {
            kind: "failed",
            tone: "danger",
            title: "Vera did not start",
            detail: state.failure ?? "The host did not start.",
        };
    }
    if (state.phase === "disconnected") {
        return {
            kind: "disconnected",
            tone: "warning",
            title: "Connection to Vera lost",
            detail: state.failure ?? "The host stopped answering.",
        };
    }
    return undefined;
}

export function buildLabel(state: UiState): string {
    const build = state.ready?.buildId;
    return build === undefined || build === null ? "unknown" : build.slice(0, 7);
}

export function toneOf(state: UiState): Tone {
    switch (state.phase) {
        case "attached":
            return "success";
        case "starting":
        case "waiting":
            return "info";
        case "disconnected":
            return "warning";
        case "failed":
        case "missing":
            return "danger";
    }
}

const PHASE_LABELS: Record<UiPhase, string> = {
    starting: "Starting",
    waiting: "Waiting",
    attached: "Attached",
    disconnected: "Disconnected",
    failed: "Failed",
    missing: "Not installed",
};

export function phaseLabel(state: UiState): string {
    return PHASE_LABELS[state.phase];
}
