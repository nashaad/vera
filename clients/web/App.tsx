import { useEffect, useState } from "react";

import type {
    UsageModelRow,
    UsageReport,
    UsageSessionRow,
    UsageWindowId,
} from "../../src/host/usage-report.ts";

const WINDOWS: readonly { readonly id: UsageWindowId; readonly label: string }[] = [
    { id: "today", label: "Today" },
    { id: "7d", label: "7 days" },
    { id: "30d", label: "30 days" },
    { id: "all", label: "All" },
];

export function UsageApp() {
    const [windowId, setWindowId] = useState<UsageWindowId>("7d");
    const [report, setReport] = useState<UsageReport | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(undefined);
        void fetch(`/api/usage?window=${windowId}`)
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`usage ${response.status}`);
                }
                return await response.json() as UsageReport;
            })
            .then((next) => {
                if (!cancelled) {
                    setReport(next);
                    setLoading(false);
                }
            })
            .catch((failure: unknown) => {
                if (!cancelled) {
                    setError(failure instanceof Error
                        ? failure.message
                        : String(failure));
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [windowId]);

    return (
        <div className="page">
            <div className="top">
                <div className="brand">Vera <span>· Usage</span></div>
                <div className="meta">this machine · this profile</div>
            </div>
            <div className="toolbar">
                <div className="seg">
                    {WINDOWS.map((entry) => (
                        <button
                            key={entry.id}
                            className={entry.id === windowId ? "on" : undefined}
                            type="button"
                            onClick={() => setWindowId(entry.id)}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
            </div>
            {loading && report === undefined
                ? <p className="note">Reading session files…</p>
                : undefined}
            {error !== undefined
                ? <p className="note">{error}</p>
                : undefined}
            {report === undefined ? undefined : <Overview report={report} />}
        </div>
    );
}

function Overview({ report }: { readonly report: UsageReport }) {
    const { totals, prior, timeline, models, sessions } = report;
    const showChart = report.window.id !== "today" && timeline.length > 0;
    return (
        <>
            <div className="metrics">
                <Metric
                    label="Spend"
                    value={money(totals.spend.combined)}
                    sub={`${money(totals.spend.reported)} reported`}
                    delta={deltaMoney(totals.spend.combined, prior?.spend.combined)}
                />
                <Metric
                    label="Requests"
                    value={formatCount(totals.calls)}
                    sub={`${totals.spend.unpricedCalls} unpriced`}
                    delta={deltaCount(totals.calls, prior?.calls)}
                />
                <Metric
                    label="Tokens"
                    value={formatTokens(totals.totalTokens)}
                    sub={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
                    delta={deltaCount(totals.totalTokens, prior?.totalTokens)}
                />
                <Metric
                    label="Cache hit"
                    value={percent(totals.cacheHitRatio)}
                    sub={`${formatTokens(totals.cachedInputTokens)} input cached`}
                    delta={deltaPoints(totals.cacheHitRatio, prior?.cacheHitRatio)}
                />
                <Metric
                    label="Blended $ / M"
                    value={totals.blendedPerMillion === undefined
                        ? "—"
                        : money(totals.blendedPerMillion)}
                    sub={report.estimatedFromOpenRouter
                        ? "at current OpenRouter rates"
                        : "reported"}
                />
            </div>
            {showChart
                ? (
                    <section className="panel">
                        <h2>Spend over time <span>· stacked by model</span></h2>
                        <Chart timeline={timeline} />
                    </section>
                )
                : undefined}
            <div className="split">
                <section className="table-card">
                    <h2>Models</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Share</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {models.slice(0, 5).map((row) => (
                                <tr key={`${row.provider}/${row.model}`}>
                                    <td className="mono">
                                        {row.provider}/{row.model}
                                    </td>
                                    <td>{shareCell(row.share)}</td>
                                    <td>{costCell(row.spend, row.kind)}</td>
                                </tr>
                            ))}
                            {models.length === 0
                                ? (
                                    <tr>
                                        <td className="faint" colSpan={3}>
                                            No priced calls in this window
                                        </td>
                                    </tr>
                                )
                                : undefined}
                        </tbody>
                    </table>
                </section>
                <section className="table-card">
                    <h2>Sessions <span>· total work cost, children included</span></h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Session</th>
                                <th>Workspace</th>
                                <th>Children</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sessions.slice(0, 8).map((row) => (
                                <SessionPreview key={row.id} row={row} />
                            ))}
                            {sessions.length === 0
                                ? (
                                    <tr>
                                        <td className="faint" colSpan={4}>
                                            No sessions in this window
                                        </td>
                                    </tr>
                                )
                                : undefined}
                        </tbody>
                    </table>
                </section>
            </div>
            <div className="footer">
                <div>
                    {money(totals.spend.reported)} reported
                    {totals.spend.estimated > 0
                        ? ` · ${money(totals.spend.estimated)} est`
                        : ""}
                    {" · "}
                    {totals.spend.unpricedCalls} calls still unpriced
                </div>
                <div>this machine · loopback</div>
            </div>
        </>
    );
}

function SessionPreview({ row }: { readonly row: UsageSessionRow }) {
    return (
        <tr>
            <td>{row.title}</td>
            <td className="ws">{row.workspaceLabel}</td>
            <td className="dim">
                {row.children > 0 ? money(row.children) : "—"}
            </td>
            <td>{costCell(row.combined, row.costKind)}</td>
        </tr>
    );
}

function Metric(props: {
    readonly label: string;
    readonly value: string;
    readonly sub: string;
    readonly delta?: string;
}) {
    return (
        <div className="metric">
            <div className="k">{props.label}</div>
            <div className="v">{props.value}</div>
            <div className="s">{props.sub}</div>
            {props.delta === undefined
                ? undefined
                : <div className="row"><span className="delta">{props.delta}</span></div>}
        </div>
    );
}

function Chart({
    timeline,
}: {
    readonly timeline: UsageReport["timeline"];
}) {
    const peak = Math.max(...timeline.map((point) => point.spend), 0.01);
    const topModels = topChartModels(timeline);
    return (
        <div className="chart">
            <div className="axis">
                <span>{money(peak)}</span>
                <span>$0</span>
            </div>
            <div className="chart-body">
                <div className="bars">
                    {timeline.map((point) => (
                        <div className="col" key={point.date} title={money(point.spend)}>
                            <div className="stack">
                                <div style={{ flex: Math.max(peak - point.spend, 0) }} />
                                {[...point.byModel].reverse().map((row) => (
                                    <div
                                        key={`${row.provider}/${row.model}`}
                                        className={`segbar ${barClass(row.model, topModels)}`}
                                        style={{ flex: row.spend }}
                                    />
                                ))}
                            </div>
                            <div className="day">{chartLabel(point.date)}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function topChartModels(
    timeline: UsageReport["timeline"],
): readonly string[] {
    const spend = new Map<string, number>();
    for (const point of timeline) {
        for (const row of point.byModel) {
            const id = `${row.provider}/${row.model}`;
            spend.set(id, (spend.get(id) ?? 0) + row.spend);
        }
    }
    return [...spend.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([id]) => id);
}

function barClass(model: string, top: readonly string[]): string {
    const index = top.findIndex((id) => id.endsWith(`/${model}`) || id === model);
    return ["opus", "sol", "glm", "rest"][index < 0 ? 3 : index] ?? "rest";
}

function chartLabel(date: string): string {
    const parts = date.split("-");
    const day = Number(parts[2]);
    if (!Number.isFinite(day)) return date.slice(5);
    const asDate = new Date(Number(parts[0]), Number(parts[1]) - 1, day);
    return asDate.toLocaleDateString(undefined, { weekday: "short" });
}

function shareCell(share: number) {
    const pct = Math.round(share * 100);
    return (
        <div className="share">
            <span>{pct}%</span>
            <span className="bar"><i style={{ width: `${pct}%` }} /></span>
        </div>
    );
}

function costCell(amount: number, kind: UsageModelRow["kind"] | UsageSessionRow["costKind"]) {
    if (kind === "unpriced" && amount === 0) {
        return <span className="faint">—</span>;
    }
    if (kind === "estimated" || kind === "mixed") {
        return <span className="est">{money(amount)} est</span>;
    }
    return money(amount);
}

function money(n: number): string {
    return `$${n.toFixed(2)}`;
}

function formatCount(n: number): string {
    return n.toLocaleString();
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function percent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
}

function deltaMoney(current: number, prior: number | undefined): string | undefined {
    if (prior === undefined) return undefined;
    const diff = current - prior;
    const sign = diff >= 0 ? "+" : "−";
    return `${sign}${money(Math.abs(diff))} vs prior`;
}

function deltaCount(current: number, prior: number | undefined): string | undefined {
    if (prior === undefined) return undefined;
    if (prior === 0) return undefined;
    const pct = Math.round((current - prior) / prior * 100);
    const sign = pct >= 0 ? "+" : "−";
    return `${sign}${Math.abs(pct)}% vs prior`;
}

function deltaPoints(current: number, prior: number | undefined): string | undefined {
    if (prior === undefined) return undefined;
    const pts = Math.round((current - prior) * 100);
    const sign = pts >= 0 ? "+" : "−";
    return `${sign}${Math.abs(pts)} pts vs prior`;
}
