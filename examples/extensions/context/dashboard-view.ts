import type {
    VeraExperimentalTuiNode,
} from "../../../src/sdk/experimental-tui.ts";
import type {
    DashboardFailureGroup,
    DashboardReport,
    DashboardSessionRow,
    DashboardSort,
} from "./dashboard-report.ts";
import { formatTokens } from "./context-report.ts";

export type DashboardWidth = "wide" | "medium" | "narrow";

export interface DashboardViewState {
    readonly sort: DashboardSort;
    readonly selected: number;
    readonly failuresOnly: boolean;
    readonly loading: boolean;
    readonly refreshedAt?: string;
}

const UNAVAILABLE = "unavailable";

/**
 * Session rows drawn at once. The overlay is one screen and the listing is
 * unbounded, so the view keeps a window around the selection and says how many
 * rows are outside it.
 */
const MAX_SESSION_ROWS = 8;
const MIN_SESSION_ROWS = 1;
/** Failure groups drawn at once; each takes a headline and a detail line. */
const MAX_FAILURE_GROUPS = 4;
/** Rows the overlay chrome takes before any section is drawn. */
const CHROME_ROWS = 10;
/** Overlay border and padding, taken off the terminal width. */
const CHROME_COLUMNS = 10;

/**
 * Column budget by terminal width. Narrower drops whole columns rather than
 * shortening them: a truncated number reads as a smaller number, while an
 * absent column reads as absent.
 */
export function dashboardWidth(columns: number): DashboardWidth {
    if (columns >= 110) return "wide";
    return columns >= 74 ? "medium" : "narrow";
}

export function renderDashboard(
    report: DashboardReport,
    state: DashboardViewState,
    columns: number,
    rows?: number,
): VeraExperimentalTuiNode {
    const width = dashboardWidth(columns);
    const inner = Math.max(20, columns - CHROME_COLUMNS);
    const build = (
        sessionRows: number,
        failureGroups: number,
    ): VeraExperimentalTuiNode[] => [
        healthSection(report, state, width),
        ...(state.failuresOnly ? [] : [
            activeSection(report, width),
            contextSection(report, width),
            modelSection(report, width),
        ]),
        failureSection(report, width, failureGroups),
        ...(state.failuresOnly
            ? []
            : [sessionSection(report, state, width, sessionRows)]),
        footer(state, width),
    ];
    return clipNode({
        kind: "stack",
        direction: "column",
        gap: 1,
        children: fit(build, rows),
    }, inner);
}

/**
 * Trims the view until it fits the rows it was given. The overlay squashes
 * overflow onto the lines below instead of scrolling it, so a view that draws
 * one row too many loses a line of real content somewhere else. Sessions give
 * way first, then failure groups; both say how many they left out.
 */
function fit(
    build: (sessionRows: number, failureGroups: number) => VeraExperimentalTuiNode[],
    rows: number | undefined,
): VeraExperimentalTuiNode[] {
    let sessionRows = MAX_SESSION_ROWS;
    let failureGroups = MAX_FAILURE_GROUPS;
    if (rows === undefined) return build(sessionRows, failureGroups);
    const available = rows - CHROME_ROWS;
    const height = (children: VeraExperimentalTuiNode[]): number =>
        children.reduce(sumHeight, 0) + Math.max(0, children.length - 1);
    let children = build(sessionRows, failureGroups);
    while (height(children) > available) {
        if (sessionRows > MIN_SESSION_ROWS) sessionRows -= 1;
        else if (failureGroups > 1) failureGroups -= 1;
        else break;
        children = build(sessionRows, failureGroups);
    }
    return children;
}

/**
 * Clips every line to the overlay's inner width. A line that wraps costs a row
 * the layout did not budget, and the overlay squashes the overflow onto the
 * lines below instead of scrolling it.
 */
function clipNode(
    node: VeraExperimentalTuiNode,
    inner: number,
): VeraExperimentalTuiNode {
    if (node.kind === "stack") {
        return {
            ...node,
            children: node.children.map((child) => clipNode(child, inner)),
        };
    }
    if (node.kind !== "text") return node;
    return { ...node, text: clip(node.text, inner) };
}

/** Rows a node draws, counting the blank line each stack gap adds. */
function sumHeight(total: number, node: VeraExperimentalTuiNode): number {
    if (node.kind !== "stack") return total + 1;
    return total + node.children.reduce(sumHeight, 0)
        + (node.gap ?? 0) * Math.max(0, node.children.length - 1);
}

function healthSection(
    report: DashboardReport,
    state: DashboardViewState,
    width: DashboardWidth,
): VeraExperimentalTuiNode {
    const health = report.health;
    const scope = health.totalSessions === undefined
        ? `${health.loadedSessions} sessions`
        : `${health.loadedSessions} of ${health.totalSessions} sessions`;
    const lines = [
        `${scope} · ${health.active} active · ${health.failed} failed`,
        `${health.calls} calls · ${
            formatTokens(health.tokens.totalTokens)
        } tokens (${formatTokens(health.tokens.inputTokens)} in, ${
            formatTokens(health.tokens.outputTokens)
        } out, ${formatTokens(health.tokens.cachedInputTokens)} cached, ${
            formatTokens(health.tokens.reasoningTokens)
        } reasoning)`,
        `cost ${formatCost(health.cost)}${
            health.unpricedCalls === 0
                ? ""
                : ` · ${health.unpricedCalls} calls unpriced`
        }`,
    ];
    return section("Health", width, [
        ...lines.map((text) => textNode(text)),
        ...(health.partial
            ? [textNode(
                "Totals cover the pages loaded so far; still reading.",
                "notice",
            )]
            : []),
        textNode(
            state.refreshedAt === undefined
                ? "not refreshed yet"
                : `snapshot ${state.refreshedAt}${
                    state.loading ? " · refreshing" : ""
                }`,
            "muted",
        ),
    ]);
}

function activeSection(
    report: DashboardReport,
    width: DashboardWidth,
): VeraExperimentalTuiNode {
    if (report.active.length === 0) {
        return section("Active now", width, [textNode("Nothing running.", "muted")]);
    }
    return section("Active now", width, report.active.map((row) =>
        textNode(
            `${row.status.padEnd(8)} ${clip(row.title, width === "narrow" ? 24 : 40)}`
                + `  ${row.model ?? UNAVAILABLE}`
                + `  ${
                    row.contextTokens === undefined
                        ? UNAVAILABLE
                        : `${formatTokens(row.contextTokens)}${
                            row.contextCapacity === undefined
                                ? ""
                                : ` / ${formatTokens(row.contextCapacity)}`
                        }${row.contextEstimated === true ? " est" : ""}`
                }`,
            row.failing ? "notice" : "text",
        )
    ));
}

function contextSection(
    report: DashboardReport,
    width: DashboardWidth,
): VeraExperimentalTuiNode {
    if (report.largestContexts.length === 0) {
        return section("Largest contexts", width, [
            textNode("No measured request contexts.", "muted"),
        ]);
    }
    return section(
        "Largest contexts",
        width,
        report.largestContexts.map((row) =>
            textNode(
                `${clip(row.title, width === "narrow" ? 26 : 42).padEnd(
                    width === "narrow" ? 26 : 42,
                )} ${formatTokens(row.tokens).padStart(7)}`
                    + `  ${
                        row.percentOfCapacity === undefined
                            ? UNAVAILABLE
                            : `${row.percentOfCapacity}%`
                    }`
                    + (row.estimated ? "  estimated" : ""),
            )
        ),
    );
}

function modelSection(
    report: DashboardReport,
    width: DashboardWidth,
): VeraExperimentalTuiNode {
    if (report.usageByModel.length === 0) {
        return section("Usage by model", width, [
            textNode("No recorded usage.", "muted"),
        ]);
    }
    return section("Usage by model", width, report.usageByModel.map((row) =>
        textNode(
            `${
                clip(`${row.provider}/${row.model}`, modelNameWidth(width))
                    .padEnd(modelNameWidth(width))
            }`
                + ` ${String(row.sessions).padStart(3)} sess`
                + ` ${String(row.calls).padStart(5)} calls`
                + ` ${formatTokens(row.tokens.totalTokens).padStart(7)}`
                + (width === "narrow"
                    ? ""
                    : `  ${formatCost(row.cost).padStart(11)}`)
                + (width === "wide" && row.unpricedCalls > 0
                    ? `  ${row.unpricedCalls} unpriced`
                    : ""),
        )
    ));
}

/** Room for the provider and model name, sized so the numbers still fit. */
function modelNameWidth(width: DashboardWidth): number {
    if (width === "narrow") return 20;
    return width === "medium" ? 26 : 44;
}

function failureSection(
    report: DashboardReport,
    width: DashboardWidth,
    maxGroups: number,
): VeraExperimentalTuiNode {
    if (report.failures.length === 0) {
        return section("Recent failures", width, [
            textNode("No recorded failures.", "muted"),
        ]);
    }
    const shown = report.failures.slice(0, Math.max(1, maxGroups));
    const hidden = report.failures.length - shown.length;
    return section("Recent failures", width, [...shown.flatMap((
        group: DashboardFailureGroup,
    ) => [
        textNode(
            `${group.provider}/${group.model} · ${group.kind}`
                + `${group.allowance ? " · credit or allowance" : ""}`
                + `  ${group.occurrences}x in ${group.sessions} ${
                    group.sessions === 1 ? "session" : "sessions"
                }`,
            "notice",
        ),
        textNode(`  ${clip(group.lastDetail, width === "narrow" ? 56 : 96)}`, "muted"),
    ]), ...(hidden === 0 ? [] : [
        textNode(
            `${hidden} more ${hidden === 1 ? "group" : "groups"}`,
            "muted",
        ),
    ])]);
}

function sessionSection(
    report: DashboardReport,
    state: DashboardViewState,
    width: DashboardWidth,
    maxRows: number,
): VeraExperimentalTuiNode {
    if (report.sessions.length === 0) {
        return section("Sessions", width, [textNode("No sessions.", "muted")]);
    }
    const start = Math.max(
        0,
        Math.min(
            state.selected - Math.floor(maxRows / 2),
            report.sessions.length - maxRows,
        ),
    );
    const rows = report.sessions.slice(start, start + maxRows);
    const hidden = report.sessions.length - rows.length;
    return section(`Sessions (by ${state.sort})`, width, [
        ...rows.map((row, index) =>
            textNode(
                sessionLine(row, width),
                start + index === state.selected ? "accent" : "text",
            )
        ),
        ...(hidden === 0 ? [] : [
            textNode(
                `${hidden} more ${hidden === 1 ? "session" : "sessions"}`
                    + " · up and down to move",
                "muted",
            ),
        ]),
    ]);
}

function sessionLine(row: DashboardSessionRow, width: DashboardWidth): string {
    const titleWidth = width === "narrow" ? 24 : width === "medium" ? 32 : 32;
    const title = clip(row.title, titleWidth).padEnd(titleWidth);
    const base = `${row.live ? "*" : " "} ${title} ${
        column(
            row.contextTokens === undefined
                ? undefined
                : formatTokens(row.contextTokens),
        )
    }`;
    if (width === "narrow") return base;
    const withTokens = `${base} ${
        column(
            row.totalTokens === undefined
                ? undefined
                : formatTokens(row.totalTokens),
        )
    } ${column(row.cost === undefined ? undefined : formatCost(row.cost))}`;
    if (width === "medium") return withTokens;
    return `${withTokens}  ${clip(row.model ?? UNAVAILABLE, 18).padEnd(18)}  ${
        clip(row.workspace, 16)
    }`;
}

/** One numeric column. Absent reads as absent, right-aligned like a number. */
function column(value: string | undefined): string {
    return (value ?? UNAVAILABLE).padStart(UNAVAILABLE.length);
}

function footer(
    state: DashboardViewState,
    width: DashboardWidth,
): VeraExperimentalTuiNode {
    const scope = state.failuresOnly ? "all" : "fail";
    if (width === "wide") {
        return textNode(
            `c context · t tokens · $ cost · f ${
                state.failuresOnly ? "all sections" : "failures only"
            }`
                + " · r refresh · enter open · esc close",
            "muted",
        );
    }
    return textNode(
        `c ctx · t tok · $ cost · f ${scope} · r refresh · esc close`,
        "muted",
    );
}

function section(
    title: string,
    width: DashboardWidth,
    children: readonly VeraExperimentalTuiNode[],
): VeraExperimentalTuiNode {
    return {
        kind: "stack",
        direction: "column",
        gap: width === "narrow" ? 0 : 1,
        children: [
            { kind: "text", text: title, bold: true, tone: "accent" },
            { kind: "rule", tone: "muted" },
            ...children,
        ],
    };
}

function textNode(
    text: string,
    tone: "text" | "muted" | "accent" | "notice" = "text",
): VeraExperimentalTuiNode {
    return { kind: "text", text, tone };
}

/** Absent and free are different answers, so an unpriced total says so. */
function formatCost(cost: number | undefined): string {
    return cost === undefined ? UNAVAILABLE : `$${cost.toFixed(4)}`;
}

function clip(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
