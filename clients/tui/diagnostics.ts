import type { TuiState } from "./state.ts";

export interface TuiDiagnosticsSnapshot {
    readonly state: TuiState;
    readonly activity: string;
    readonly elapsed: string;
    readonly sessionId?: string;
    readonly workspace: string;
    readonly runningBackgroundAgents: number;
    readonly now?: number;
}

export function renderTuiDiagnostics(
    snapshot: TuiDiagnosticsSnapshot,
): string {
    const { state } = snapshot;
    const lines = [
        "Diagnostics",
        `  turn         ${state.working ? snapshot.activity : "idle"}`,
        `  elapsed      ${state.working ? snapshot.elapsed : "—"}`,
        `  cancellable  ${state.working ? "yes" : "no"}`,
        `  queued       ${state.queuedPrompts.length}`,
    ];

    const model = state.modelActivity;
    if (model !== undefined) {
        const now = snapshot.now ?? Date.now();
        const retrying = Date.parse(model.retryAt) > now;
        lines.push(`  model        ${model.model}`);
        lines.push(
            `  request      ${retrying ? "retry" : "attempt"}`
                + ` ${model.nextAttempt} of ${model.maxAttempts}`,
        );
        lines.push(
            `  last failure ${model.failure.kind}`
                + `${model.failure.statusCode === undefined
                    ? ""
                    : ` (${model.failure.statusCode})`}`,
        );
        if (retrying) {
            lines.push(`  retry in     ${retryDelay(model.retryAt, now)}`);
        }
    } else if (state.modelSettings !== undefined) {
        lines.push(`  model        ${state.modelSettings.model}`);
    }
    if (state.modelSettings !== undefined) {
        const effort = state.modelSettings.reasoningEffort ?? "default";
        lines.push(`  reasoning    ${effort}`);
        const child = state.modelSettings.subagentDefault;
        if (child === undefined) {
            lines.push("  subagents    unknown (restart the resident host)");
        } else if (child.mode === "fixed") {
            const identity = child.provider === undefined
                ? child.model
                : `${child.provider}/${child.model}`;
            lines.push(`  subagents    ${identity} (${child.reasoningEffort ?? "default"})`);
        } else {
            lines.push(
                `  subagents    inherit parent (${state.modelSettings.model}, ${effort})`,
            );
        }
    }

    if (state.context !== undefined) {
        const capacity = state.context.capacity;
        const usage = capacity === undefined
            ? `${state.context.tokens} tokens`
            : `${state.context.tokens} / ${capacity}`
                + ` (${Math.round(state.context.tokens / capacity * 100)}%)`;
        lines.push(
            `  context      ${usage}${state.context.estimated ? " estimated" : ""}`,
        );
    } else {
        lines.push("  context      unavailable");
    }

    lines.push(`  session      ${snapshot.sessionId ?? "unavailable"}`);
    lines.push(`  workspace    ${snapshot.workspace}`);
    lines.push(`  background   ${snapshot.runningBackgroundAgents} running`);
    return lines.join("\n");
}

function retryDelay(retryAt: string, now: number): string {
    const remainingMs = Math.max(0, Date.parse(retryAt) - now);
    return `${Math.ceil(remainingMs / 1_000)}s`;
}
