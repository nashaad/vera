import type { StashSummary } from "../../src/store/preimage-stash.ts";
import type { TuiState } from "./state.ts";

export interface TuiDiagnosticsSnapshot {
    readonly state: TuiState;
    readonly activity: string;
    readonly elapsed: string;
    readonly sessionId?: string;
    readonly workspace: string;
    readonly runningBackgroundAgents: number;
    readonly stash?: StashSummary;
    readonly stashRoot?: string;
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
    lines.push(...stashLines(snapshot));
    return lines.join("\n");
}

function stashLines(snapshot: TuiDiagnosticsSnapshot): string[] {
    if (snapshot.stashRoot === undefined) {
        return [];
    }
    const stash = snapshot.stash;
    if (stash === undefined) {
        return [`  stash        empty (${snapshot.stashRoot})`];
    }
    const oldest = stash.oldestCapturedAt === undefined
        ? ""
        : `, oldest ${age(stash.oldestCapturedAt, snapshot.now ?? Date.now())}`;
    return [
        `  stash        ${stash.preimages} pre-image${stash.preimages === 1 ? "" : "s"}`
            + ` across ${stash.sessions} session${stash.sessions === 1 ? "" : "s"}`
            + ` (${formatStashBytes(stash.bytes)}${oldest})`,
        `               files overwritten by write/edit keep a copy in ${snapshot.stashRoot}/<session>/;`,
        "               each <key>.json names its original path; restore with: cp <key> <path>",
    ];
}

function age(capturedAt: string, now: number): string {
    const ms = Math.max(0, now - Date.parse(capturedAt));
    const hours = ms / (60 * 60 * 1000);
    if (hours < 1) {
        return `${Math.max(1, Math.round(ms / (60 * 1000)))}m`;
    }
    return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function formatStashBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    return bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function retryDelay(retryAt: string, now: number): string {
    const remainingMs = Math.max(0, Date.parse(retryAt) - now);
    return `${Math.ceil(remainingMs / 1_000)}s`;
}
