import { useEffect, useState } from "react";

import type {
    RunAttemptView,
    RunDetail,
    RunRow,
    RunSpanView,
} from "../../src/annex/runs-report.ts";
import { AnnexChrome } from "./App.tsx";

export function RunsApp() {
    const [runId, setRunId] = useState<string | undefined>();
    return runId === undefined
        ? <RunList onOpen={setRunId} />
        : <RunPage runId={runId} onBack={() => setRunId(undefined)} />;
}

function RunList({ onOpen }: { readonly onOpen: (id: string) => void }) {
    const rows = useJson<{ readonly rows: readonly RunRow[] }>("/api/runs");

    return (
        <div className="page">
            <AnnexChrome page="runs" onHome={() => {}} />
            {rows.error !== undefined ? <p className="note">{rows.error}</p> : undefined}
            {rows.value === undefined
                ? <p className="note live">Reading workflow journals…</p>
                : rows.value.rows.length === 0
                ? <p className="note">No workflow runs yet.</p>
                : (
                    <section className="table-card">
                        <h2>Runs <span>{rows.value.rows.length}</span></h2>
                        <div className="table-scroll">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Workflow</th>
                                        <th>Status</th>
                                        <th>Started</th>
                                        <th>Duration</th>
                                        <th>Steps</th>
                                        <th>Tries</th>
                                        <th>Cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.value.rows.map((row) => (
                                        <tr
                                            key={row.runId}
                                            className="click"
                                            onClick={() => onOpen(row.runId)}
                                        >
                                            <td className="title">
                                                {row.workflow === "" ? row.runId : row.workflow}
                                                <div className="mono faint">{row.runId}</div>
                                            </td>
                                            <td><Status status={row.status} /></td>
                                            <td className="dim">{clock(row.startedAt)}</td>
                                            <td>{row.ms === undefined ? "—" : duration(row.ms)}</td>
                                            <td>{row.steps}</td>
                                            <td>
                                                {row.tries}
                                                {row.failedTries === 0
                                                    ? undefined
                                                    : (
                                                        <span className="faint">
                                                            {" "}({row.failedTries} failed)
                                                        </span>
                                                    )}
                                            </td>
                                            <td>{money(row.cost)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}
        </div>
    );
}

function RunPage({
    runId,
    onBack,
}: {
    readonly runId: string;
    readonly onBack: () => void;
}) {
    const detail = useJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);

    return (
        <div className="page">
            <AnnexChrome page="runs" onHome={onBack} />
            <button className="back" type="button" onClick={onBack}>← Runs</button>
            {detail.error !== undefined ? <p className="note">{detail.error}</p> : undefined}
            {detail.value === undefined ? undefined : (
                <>
                    <div className="detail-head">
                        <h1>{detail.value.workflow}</h1>
                        <p className="meta mono">{detail.value.runId}</p>
                        <p className="meta">
                            <Status status={detail.value.status} />
                            {detail.value.cost === undefined ? undefined : (
                                <span className="faint">
                                    {"  "}{money(detail.value.cost)}
                                </span>
                            )}
                            {detail.value.active === undefined ? undefined : (
                                <span className="faint">
                                    {"  in "}{detail.value.active.step}
                                    {" since "}{clock(detail.value.active.at)}
                                </span>
                            )}
                        </p>
                    </div>
                    {detail.value.asking === undefined ? undefined : (
                        <section className="panel">
                            <h2>Waiting for an answer</h2>
                            <p className="question">{detail.value.asking.question}</p>
                            <p className="meta">
                                {"Asked "}{clock(detail.value.asking.at)}
                                {". Answer with "}
                                <code>{`python -m vera.workflow answer ${detail.value.runId}`}</code>
                            </p>
                        </section>
                    )}
                    {detail.value.attempts.map((attempt) => (
                        <Attempt key={attempt.number} attempt={attempt} />
                    ))}
                    {detail.value.orphanSpans.length === 0 ? undefined : (
                        <section className="panel">
                            <h2>Spans with no attempt <span>{detail.value.orphanSpans.length}</span></h2>
                            <Waterfall spans={detail.value.orphanSpans} />
                        </section>
                    )}
                </>
            )}
        </div>
    );
}

function Attempt({ attempt }: { readonly attempt: RunAttemptView }) {
    return (
        <section className="panel">
            <h2>
                Attempt {attempt.number}{" "}
                <span>
                    {attempt.host} pid {attempt.pid} · {clock(attempt.startedAt)} ·{" "}
                    {attempt.status ?? "did not finish"}
                </span>
            </h2>
            {attempt.spans.length === 0
                ? <p className="note">No steps ran in this attempt.</p>
                : <Waterfall spans={attempt.spans} />}
        </section>
    );
}

function Waterfall({ spans }: { readonly spans: readonly RunSpanView[] }) {
    const starts = spans.map((span) => Date.parse(span.start));
    const ends = spans.map((span, index) =>
        span.end === undefined ? starts[index] ?? 0 : Date.parse(span.end)
    );
    const first = Math.min(...starts);
    // A run faster than the clock resolution would divide by zero.
    let total = Math.max(Math.max(...ends) - first, 1);
    const openStarts = starts.filter(
        (_, index) => spans[index]?.end === undefined,
    );
    if (openStarts.length > 0) {
        // A span that never ended has no duration to draw, so it runs to the
        // right edge with room to be seen rather than a made-up length.
        total = Math.max(total, (Math.max(...openStarts) - first) / 0.8);
    }

    return (
        <ol className="wf">
            {spans.map((span, index) => {
                const open = span.end === undefined;
                const from = ((starts[index] ?? first) - first) / total;
                const width = open
                    ? 1 - from
                    : ((ends[index] ?? first) - (starts[index] ?? first)) / total;
                return (
                    <li key={span.spanId}>
                        <span
                            className={span.model === undefined
                                ? "wf-name"
                                : "wf-name wf-call"}
                            style={{ paddingLeft: `${span.depth * 12}px` }}
                        >
                            {span.step}
                        </span>
                        <span className="wf-track">
                            <i
                                className={`wf-bar ${open ? "open" : span.outcome ?? ""}`}
                                style={{
                                    left: `${from * 100}%`,
                                    width: `${Math.max(width * 100, 1.5)}%`,
                                }}
                            />
                        </span>
                        <span className="wf-ms">
                            {span.ms === undefined ? "open" : duration(span.ms)}
                        </span>
                        {span.message === undefined
                            ? undefined
                            : <span className="wf-note">{span.message}</span>}
                        {span.model === undefined ? undefined : (
                            <span className="wf-note">
                                {span.tokens === undefined
                                    ? "no tokens reported"
                                    : `${span.tokens.toLocaleString()} tokens`}
                                {span.cost === undefined
                                    ? ""
                                    : `  ${money(span.cost)}`}
                            </span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

function Status({ status }: { readonly status: string }) {
    return <span className={`status ${status}`}>{status}</span>;
}

function useJson<T>(path: string): {
    readonly value: T | undefined;
    readonly error: string | undefined;
} {
    const [value, setValue] = useState<T | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        const controller = new AbortController();
        setValue(undefined);
        setError(undefined);
        void fetch(path, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`${path} ${response.status}`);
                }
                return await response.json() as T;
            })
            .then(setValue)
            .catch((failure: unknown) => {
                if (controller.signal.aborted) return;
                setError(failure instanceof Error ? failure.message : String(failure));
            });
        return () => {
            controller.abort();
        };
    }, [path]);

    return { value, error };
}

function duration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function money(usd: number | undefined): string {
    if (usd === undefined) return "\u2014";
    return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function clock(at: string): string {
    if (at === "") return "—";
    const when = new Date(at);
    return Number.isNaN(when.getTime()) ? at : when.toLocaleString();
}
