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
        readonly clientEntrypoint: string;
        readonly hostEntrypoint?: string;
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
        ...sectionHeading("Session"),
        ...fieldTable([
            ["Identity", snapshot.sessionIdentity ?? "Unavailable"],
            ["ID", snapshot.sessionId ?? "Unavailable"],
            ["File", snapshot.sessionPath ?? "Unavailable"],
            ["Workspace", snapshot.workspace],
            ["Background", `${snapshot.runningBackgroundAgents} running`],
        ]),
        "",
        ...sectionHeading("Processes"),
        ...processTableLines(snapshot.processes),
        "",
        ...sectionHeading("Session usage"),
        ...sessionUsageLines(state.sessionUsage),
        "",
        ...sectionHeading("Runtime"),
        ...fieldTable([
            ["Turn", state.working ? snapshot.activity : "Idle"],
            ["Elapsed", state.working ? snapshot.elapsed : "—"],
            ["Cancellable", state.working ? "Yes" : "No"],
            ["Queued", String(state.queuedPrompts.length)],
        ]),
    ];

    const model = state.modelActivity;
    const modelRows: string[][] = [];
    lines.push("", ...sectionHeading("Model"));
    if (model !== undefined) {
        const now = snapshot.now ?? Date.now();
        const retrying = Date.parse(model.retryAt) > now;
        modelRows.push(["Model", model.model]);
        modelRows.push([
            "Request",
            `${retrying ? "Retry" : "Attempt"}`
                + ` ${model.nextAttempt} of ${model.maxAttempts}`,
        ]);
        modelRows.push([
            "Last failure",
            `${model.failure.kind}`
                + `${model.failure.statusCode === undefined
                    ? ""
                    : ` (${model.failure.statusCode})`}`,
        ]);
        if (retrying) {
            modelRows.push(["Retry in", retryDelay(model.retryAt, now)]);
        }
    } else if (state.modelSettings !== undefined) {
        modelRows.push(["Model", state.modelSettings.model]);
    }
    if (state.modelSettings !== undefined) {
        const effort = state.modelSettings.reasoningEffort ?? "default";
        modelRows.push(["Reasoning", effort]);
        modelRows.push([
            "Context cap",
            String(state.modelSettings.contextLimit ?? "auto"),
        ]);
        if (state.modelSettings.modelContextWindow !== undefined) {
            modelRows.push([
                "Model window",
                String(state.modelSettings.modelContextWindow),
            ]);
        }
        const child = state.modelSettings.subagentDefault;
        if (child === undefined) {
            modelRows.push([
                "Subagents",
                "Unknown (restart the resident host)",
            ]);
        } else if (child.mode === "fixed") {
            const identity = child.provider === undefined
                ? child.model
                : `${child.provider}/${child.model}`;
            modelRows.push([
                "Subagents",
                `${identity} (${child.reasoningEffort ?? "default"})`,
            ]);
        } else {
            modelRows.push([
                "Subagents",
                `Inherit parent (${state.modelSettings.model}, ${effort})`,
            ]);
        }
    }

    if (state.context !== undefined) {
        const capacity = state.context.capacity;
        const usage = capacity === undefined
            ? `${state.context.tokens} tokens`
            : `${state.context.tokens} / ${capacity}`
                + ` (${Math.round(state.context.tokens / capacity * 100)}%)`;
        modelRows.push([
            "Context",
            `${usage}${state.context.estimated ? " estimated" : ""}`,
        ]);
    } else {
        modelRows.push(["Context", "Unavailable"]);
    }
    lines.push(...fieldTable(modelRows));
    return lines.join("\n");
}

function processTableLines(
    processes: readonly TuiDiagnosticProcess[] | undefined,
): string[] {
    if (processes === undefined || processes.length === 0) {
        return ["Unavailable."];
    }
    return markdownTable(
        ["Role", "PID", "Memory"],
        processes.map((process) => [
            process.role,
            String(process.pid),
            process.rssBytes === undefined
                ? "Unavailable"
                : formatMemory(process.rssBytes),
        ]),
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
        ...sectionHeading("Build"),
        ...markdownTable(
            ["", ""],
            [
                ["Client", snapshot.build?.clientVersion ?? "unknown"],
                ["Client entrypoint", snapshot.build?.clientEntrypoint ?? "unknown"],
                ["Host", hostLabel(snapshot)],
                ["Host entrypoint", snapshot.build?.hostEntrypoint ?? "unknown"],
            ],
        ),
        "",
        ...sectionHeading("Startup"),
        ...startupSummaryLines(snapshot.startup),
        "",
        ...sectionHeading("Startup extensions"),
        ...startupExtensionLines(snapshot.startup),
        "",
        ...sectionHeading("Extensions"),
        ...extensionLines(snapshot),
        "",
        ...clientExtensionReloadLines(snapshot),
        "",
        ...sectionHeading("Model failures"),
        ...modelFailureLines(snapshot),
        "",
        ...sectionHeading("Pre-image stash"),
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
    const details: string[][] = [];
    if (snapshot.modelFailureLedgerPath !== undefined) {
        details.push(["Ledger", snapshot.modelFailureLedgerPath]);
    }
    const worst = summary.signatures[0];
    if (worst !== undefined) {
        details.push(["Last error", worst.lastDetail]);
        if (worst.lastRequestTokens !== undefined) {
            details.push([
                "Last request",
                `${worst.lastRequestTokens.toLocaleString()}`
                    + `${worst.lastRequestTokensEstimated ? " estimated" : ""}`
                    + " tokens (attempted, not billed usage)",
            ]);
        }
        if (worst.lastAllowance !== undefined) {
            details.push([
                "Allowance",
                `${worst.lastAllowance.available.toLocaleString()}`
                    + ` ${worst.lastAllowance.kind.replace("_", " ")}`,
            ]);
        }
    }
    if (details.length > 0) {
        lines.push("", "### Latest detail", ...fieldTable(details));
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
    const row = (cells: readonly string[]) =>
        `| ${cells.map(markdownTableCell).join(" | ")} |`;
    return [
        row(headings),
        row(headings.map(() => "---")),
        ...rows.map(row),
    ];
}

function fieldTable(rows: readonly (readonly string[])[]): string[] {
    return markdownTable(["", ""], rows);
}

function sectionHeading(title: string): string[] {
    return [`## ${title.toUpperCase()}`, "", "---"];
}

function markdownTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
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
        return ["### Client reload", ...fieldTable([["Status", "Never"]])];
    }
    if (reload.status === "reloading") {
        return [
            "### Client reload",
            ...fieldTable([["Status", "Reloading"]]),
        ];
    }
    const loaded = reload.loadedExtensionIds.length;
    const label = reload.status === "success"
        ? `success (${loaded} loaded)`
        : reload.status === "partial"
        ? `partial (${loaded} loaded)`
        : "failed";
    const rows: string[][] = [["Status", label]];
    if (loaded > 0) {
        rows.push([
            "Active",
            reload.loadedExtensionIds
                .slice(0, MAX_ACTIVE_EXTENSION_IDS).join(", "),
        ]);
        if (loaded > MAX_ACTIVE_EXTENSION_IDS) {
            rows.push([
                "Active",
                `+ ${loaded - MAX_ACTIVE_EXTENSION_IDS} more`,
            ]);
        }
    }
    for (const failure of reload.failures.slice(0, 3)) {
        rows.push(["Error", failure]);
    }
    if (reload.failures.length > 3) {
        rows.push(["Error", `+ ${reload.failures.length - 3} more`]);
    }
    return ["### Client reload", ...fieldTable(rows)];
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
        return ["None configured."];
    }
    return markdownTable(
        ["State", "Path"],
        snapshot.extensions.map((extension) => [
            extension.enabled ? "Enabled" : "Disabled",
            extension.path,
        ]),
    );
}

function stashLines(snapshot: TuiDiagnosticsSnapshot): string[] {
    if (snapshot.stashRoot === undefined) {
        return [];
    }
    const stash = snapshot.stash;
    if (stash === undefined) {
        return fieldTable([
            ["Stash", "Empty"],
            ["Filesystem", snapshot.stashRoot],
        ]);
    }
    const now = snapshot.now ?? Date.now();
    const oldest = stash.oldestCapturedAt === undefined
        ? ""
        : `, oldest ${age(stash.oldestCapturedAt, now)}`;
    const lines = fieldTable([[
        "Stash",
        `${stash.preimages} pre-image${stash.preimages === 1 ? "" : "s"}`
            + ` across ${stash.sessions} session${stash.sessions === 1 ? "" : "s"}`
            + ` (${formatStashBytes(stash.bytes)}${oldest})`,
    ], ["Filesystem", snapshot.stashRoot]]);
    lines.push(
        "",
        "### Recent captures",
        ...markdownTable(
            ["Age", "Size", "Original", "Saved in"],
            stash.entries.slice(0, MAX_STASH_ENTRIES).map((entry) => [
                `${age(entry.capturedAt, now)} ago`,
                formatStashBytes(entry.bytes),
                entry.path,
                `${snapshot.stashRoot}/${entry.sessionId}`,
            ]),
        ),
    );
    const hidden = stash.entries.length - MAX_STASH_ENTRIES;
    if (hidden > 0) {
        lines.push(`> ${hidden} more in ${snapshot.stashRoot}.`);
    }
    lines.push(
        "",
        "> Restore: the `<key>.json` sidecar names the original path; run `cp <key> <path>`.",
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
