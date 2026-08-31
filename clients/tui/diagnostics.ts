import type { StashSummary } from "../../src/store/preimage-stash.ts";
import type { ModelFailureSummary } from "../../src/store/model-failures.ts";
import type { TuiState } from "./state.ts";
import type {
    HostStartupTimingRow,
    HostStartupTimingSnapshot,
} from "./host-startup-diagnostics.ts";

export type TuiDiagnosticsScope = "session" | "vera";

export interface TuiDiagnosticProcess {
    readonly role: "client" | "host" | "worker" | "supervisor";
    readonly pid: number;
    readonly rssBytes?: number;
}

export interface TuiDiagnosticsSnapshot {
    readonly state: TuiState;
    readonly activity: string;
    readonly elapsed: string;
    readonly scope?: TuiDiagnosticsScope;
    readonly sessionId?: string;
    readonly sessionIdentity?: string;
    readonly sessionPath?: string;
    readonly workspace: string;
    readonly runningBackgroundAgents: number;
    readonly processes?: readonly TuiDiagnosticProcess[];
    readonly stash?: StashSummary;
    readonly stashRoot?: string;
    readonly modelFailures?: ModelFailureSummary;
    readonly modelFailureLedgerPath?: string;
    readonly now?: number;
    readonly build?: {
        readonly clientVersion: string;
        readonly hostBuildId?: string;
        readonly hostPid?: number;
        readonly hostStartedAt?: string;
    };
    readonly extensions?: readonly {
        readonly path: string;
        readonly enabled: boolean;
    }[];
    readonly clientExtensionReload?: TuiClientExtensionReloadSnapshot;
    readonly startup?: HostStartupTimingSnapshot;
}

export interface TuiClientExtensionReloadSnapshot {
    readonly status: "never" | "reloading" | "success" | "partial" | "failed";
    readonly loadedExtensionIds: readonly string[];
    readonly failures: readonly string[];
}

export function renderTuiDiagnostics(
    snapshot: TuiDiagnosticsSnapshot,
): string {
    return snapshot.scope === "vera"
        ? renderVeraDiagnostics(snapshot)
        : renderSessionDiagnostics(snapshot);
}

function renderSessionDiagnostics(snapshot: TuiDiagnosticsSnapshot): string {
    const { state } = snapshot;
    const lines = [
        "# Session diagnostics",
        "## Session",
        `  identity     ${snapshot.sessionIdentity ?? "unavailable"}`,
        `  id           ${snapshot.sessionId ?? "unavailable"}`,
        `  file         ${snapshot.sessionPath ?? "unavailable"}`,
        `  workspace    ${snapshot.workspace}`,
        `  background   ${snapshot.runningBackgroundAgents} running`,
        "",
        "## Processes",
        ...processLines(snapshot.processes),
        "",
        "## Session usage",
        ...sessionUsageLines(state.sessionUsage),
        "",
        "## Runtime",
        `  turn         ${state.working ? snapshot.activity : "idle"}`,
        `  elapsed      ${state.working ? snapshot.elapsed : "—"}`,
        `  cancellable  ${state.working ? "yes" : "no"}`,
        `  queued       ${state.queuedPrompts.length}`,
    ];

    const model = state.modelActivity;
    lines.push("");
    lines.push("## Model");
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
        lines.push(
            `  context cap  ${state.modelSettings.contextLimit ?? "auto"}`,
        );
        if (state.modelSettings.modelContextWindow !== undefined) {
            lines.push(
                `  model window ${state.modelSettings.modelContextWindow}`,
            );
        }
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
    return lines.join("\n");
}

function processLines(
    processes: readonly TuiDiagnosticProcess[] | undefined,
): string[] {
    if (processes === undefined || processes.length === 0) {
        return ["  unavailable"];
    }
    return processes.map((process) =>
        `  ${process.role.padEnd(10)} PID ${process.pid}`
        + ` · ${process.rssBytes === undefined
            ? "memory unavailable"
            : formatMemory(process.rssBytes)}`
    );
}

function formatMemory(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function renderVeraDiagnostics(snapshot: TuiDiagnosticsSnapshot): string {
    return [
        "# Vera diagnostics",
        "## Build",
        ...markdownTable(
            ["Component", "Value"],
            [
                ["Client", snapshot.build?.clientVersion ?? "unknown"],
                ["Host", snapshot.build?.hostBuildId ?? "unknown"],
                ["Host process", hostLabel(snapshot)],
            ],
        ),
        "",
        "## Startup",
        ...startupSummaryLines(snapshot.startup),
        "",
        "## Startup extensions",
        ...startupExtensionLines(snapshot.startup),
        "",
        "## Extensions",
        ...extensionLines(snapshot),
        ...clientExtensionReloadLines(snapshot),
        "",
        "## Model failures",
        ...modelFailureLines(snapshot),
        "",
        "## Pre-image stash",
        ...stashLines(snapshot),
    ].join("\n");
}

/** Most repeated first: the top row is the one worth acting on. */
function modelFailureLines(snapshot: TuiDiagnosticsSnapshot): string[] {
    const summary = snapshot.modelFailures;
    if (summary === undefined) return ["  unavailable"];
    if (summary.signatures.length === 0) {
        return ["  No recorded model failures."];
    }
    const now = snapshot.now ?? Date.now();
    const lines = markdownTable(
        ["Model", "Failure", "Count", "Sessions", "Last"],
        summary.signatures.slice(0, MAX_FAILURE_SIGNATURES).map((entry) => [
            `${entry.provider}/${entry.model}`,
            entry.kind.replaceAll("_", " "),
            String(entry.count),
            String(entry.sessions),
            age(entry.lastSeenAt, now),
        ]),
    );
    const hidden = summary.signatures.length - MAX_FAILURE_SIGNATURES;
    if (hidden > 0) {
        lines.push(`> ${hidden} more not listed.`);
    }
    if (snapshot.modelFailureLedgerPath !== undefined) {
        lines.push(`  ledger       ${snapshot.modelFailureLedgerPath}`);
    }
    const worst = summary.signatures[0];
    if (worst !== undefined) {
        lines.push(`  last error   ${worst.lastDetail}`);
        if (worst.lastRequestTokens !== undefined) {
            lines.push(
                `  last request ${worst.lastRequestTokens.toLocaleString()}`
                    + `${worst.lastRequestTokensEstimated ? " estimated" : ""}`
                    + " tokens (attempted, not billed usage)",
            );
        }
        if (worst.lastAllowance !== undefined) {
            lines.push(
                `  allowance    ${worst.lastAllowance.available.toLocaleString()}`
                    + ` ${worst.lastAllowance.kind.replace("_", " ")}`,
            );
        }
    }
    return lines;
}

function sessionUsageLines(
    usage: TuiState["sessionUsage"],
): string[] {
    if (usage === undefined || usage.rows.length === 0) {
        return ["No recorded model calls."];
    }
    const totals = usage.rows.reduce((total, row) => ({
        calls: total.calls + row.calls,
        durationMs: total.durationMs + row.durationMs,
        inputTokens: total.inputTokens + row.inputTokens,
        outputTokens: total.outputTokens + row.outputTokens,
        cachedInputTokens: total.cachedInputTokens + row.cachedInputTokens,
        reasoningTokens: total.reasoningTokens + row.reasoningTokens,
        totalTokens: total.totalTokens + row.totalTokens,
        cost: total.cost + (row.cost ?? 0),
        callsWithoutCost: total.callsWithoutCost + row.callsWithoutCost,
    }), {
        calls: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cost: 0,
        callsWithoutCost: 0,
    });
    const lines = [
        ...markdownTable(
            ["Metric", "Value"],
            [
                ["Calls", String(totals.calls)],
                ["Runtime", formatDuration(totals.durationMs)],
                ["Tokens", formatTokens(totals.totalTokens)],
                ["Input", formatTokens(totals.inputTokens)],
                ["Output", formatTokens(totals.outputTokens)],
                ["Cached", formatTokens(totals.cachedInputTokens)],
                ["Reasoning", formatTokens(totals.reasoningTokens)],
                ["Cost", formatCost(
                    totals.cost,
                    totals.calls,
                    totals.callsWithoutCost,
                )],
            ],
        ),
        "",
        ...usage.rows.flatMap((row, index) => [
            `### ${row.provider}/${row.model}`,
            ...markdownTable(
                ["Metric", "Value"],
                [
                    ["Calls", String(row.calls)],
                    ["Runtime", formatDuration(row.durationMs)],
                    ["Tokens", formatTokens(row.totalTokens)],
                    ["Input", formatTokens(row.inputTokens)],
                    ["Output", formatTokens(row.outputTokens)],
                    ["Cached", formatTokens(row.cachedInputTokens)],
                    ["Reasoning", formatTokens(row.reasoningTokens)],
                    ["Cost", formatCost(
                        row.cost ?? 0,
                        row.calls,
                        row.callsWithoutCost,
                    )],
                ],
            ),
            ...(index === usage.rows.length - 1 ? [] : [""]),
        ]),
    ];
    if (totals.callsWithoutCost > 0) {
        lines.push(
            "",
            "> Cost unavailable where the provider did not report it. Vera does not estimate prices.",
        );
    }
    return lines;
}

function markdownTable(
    headings: readonly string[],
    rows: readonly (readonly string[])[],
): string[] {
    const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
    return [
        row(headings),
        row(headings.map(() => "---")),
        ...rows.map(row),
    ];
}

function formatTokens(tokens: number): string {
    return Intl.NumberFormat("en-US").format(tokens);
}

function formatCost(
    cost: number,
    calls: number,
    callsWithoutCost: number,
): string {
    if (callsWithoutCost === calls) {
        return `cost unavailable · ${callsWithoutCost} unpriced`;
    }
    const amount = `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
    return callsWithoutCost === 0
        ? amount
        : `${amount} reported · ${callsWithoutCost} unpriced`;
}

function startupSummaryLines(
    startup: HostStartupTimingSnapshot | undefined,
): string[] {
    if (startup === undefined) return ["Unavailable."];
    const rows = startup.rows.filter((row) =>
        !row.label.startsWith("extension · ")
    );
    return timingTable([
        { label: "total", durationMs: startup.totalMs, outcome: "completed" },
        ...rows,
    ]);
}

function startupExtensionLines(
    startup: HostStartupTimingSnapshot | undefined,
): string[] {
    if (startup === undefined) return ["Unavailable."];
    const rows = startup.rows.filter((row) =>
        row.label.startsWith("extension · ")
    );
    return rows.length === 0 ? ["None."] : timingTable(rows);
}

function timingTable(rows: readonly HostStartupTimingRow[]): string[] {
    const slowest = rows.filter((row) => row.label !== "total")
        .reduce<HostStartupTimingRow | undefined>(
        (current, row) =>
            current === undefined || row.durationMs > current.durationMs
                ? row
                : current,
        undefined,
    );
    return markdownTable(
        ["Phase", "Time", "Status"],
        rows.map((row) => [
            row.label,
            formatDuration(row.durationMs),
            [
                row.outcome === "failed" ? "failed" : "ok",
                row === slowest ? "slowest" : "",
            ].filter(Boolean).join(", "),
        ]),
    );
}

function formatDuration(durationMs: number): string {
    return durationMs < 1_000
        ? `${Math.round(durationMs)}ms`
        : `${(durationMs / 1_000).toFixed(2)}s`;
}

function clientExtensionReloadLines(
    snapshot: TuiDiagnosticsSnapshot,
): string[] {
    const reload = snapshot.clientExtensionReload;
    if (reload === undefined || reload.status === "never") {
        return ["  reload       never"];
    }
    if (reload.status === "reloading") {
        return ["  reload       reloading"];
    }
    const loaded = reload.loadedExtensionIds.length;
    const label = reload.status === "success"
        ? `success (${loaded} loaded)`
        : reload.status === "partial"
        ? `partial (${loaded} loaded)`
        : "failed";
    const lines = [`  reload       ${label}`];
    if (loaded > 0) {
        lines.push(
            `  active       ${reload.loadedExtensionIds
                .slice(0, MAX_ACTIVE_EXTENSION_IDS).join(", ")}`,
        );
        if (loaded > MAX_ACTIVE_EXTENSION_IDS) {
            lines.push(
                `  active       + ${loaded - MAX_ACTIVE_EXTENSION_IDS} more`,
            );
        }
    }
    for (const failure of reload.failures.slice(0, 3)) {
        lines.push(`  reload error ${failure}`);
    }
    if (reload.failures.length > 3) {
        lines.push(`  reload error + ${reload.failures.length - 3} more`);
    }
    return lines;
}

const MAX_ACTIVE_EXTENSION_IDS = 20;

function hostLabel(snapshot: TuiDiagnosticsSnapshot): string {
    const pid = snapshot.build?.hostPid;
    const started = snapshot.build?.hostStartedAt;
    if (pid === undefined) return "unknown";
    return `PID ${pid}${started === undefined ? "" : ` · started ${started}`}`;
}

function extensionLines(snapshot: TuiDiagnosticsSnapshot): string[] {
    if (snapshot.extensions === undefined || snapshot.extensions.length === 0) {
        return ["  none configured"];
    }
    return snapshot.extensions.map((extension) =>
        `  ${extension.enabled ? "enabled " : "disabled"}      ${extension.path}`
    );
}

function stashLines(snapshot: TuiDiagnosticsSnapshot): string[] {
    if (snapshot.stashRoot === undefined) {
        return [];
    }
    const stash = snapshot.stash;
    if (stash === undefined) {
        return [`  stash        empty`, `  filesystem   ${snapshot.stashRoot}`];
    }
    const now = snapshot.now ?? Date.now();
    const oldest = stash.oldestCapturedAt === undefined
        ? ""
        : `, oldest ${age(stash.oldestCapturedAt, now)}`;
    const lines = [
        `  stash        ${stash.preimages} pre-image${stash.preimages === 1 ? "" : "s"}`
            + ` across ${stash.sessions} session${stash.sessions === 1 ? "" : "s"}`
            + ` (${formatStashBytes(stash.bytes)}${oldest})`,
    ];
    for (const entry of stash.entries.slice(0, MAX_STASH_ENTRIES)) {
        lines.push(
            `               ${age(entry.capturedAt, now)} ago`
                + `  ${formatStashBytes(entry.bytes)}`
                + `  ${entry.path}  (${snapshot.stashRoot}/${entry.sessionId})`,
        );
    }
    const hidden = stash.entries.length - MAX_STASH_ENTRIES;
    if (hidden > 0) {
        lines.push(`               + ${hidden} more in ${snapshot.stashRoot}`);
    }
    lines.push(
        "               restore: the <key>.json sidecar names the original path; cp <key> <path>",
    );
    return lines;
}

const MAX_STASH_ENTRIES = 15;
const MAX_FAILURE_SIGNATURES = 10;

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
