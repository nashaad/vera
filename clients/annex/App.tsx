import { useEffect, useMemo, useRef, useState, type KeyboardEvent as InputKeyEvent } from "react";

import type {
    UsageCallRow,
    UsageModelRow,
    UsageReport,
    UsageSessionDetail,
    UsageSessionRow,
    UsageToolCount,
    UsageWindowId,
} from "../../src/annex/usage-report.ts";
import {
    DEFAULT_SESSION_SORT,
    modelListQuery,
    modelQueryMatches,
    nextSessionSort,
    pageSlice,
    SESSION_PAGE_SIZE,
    sessionMatchesModelFilter,
    sortSessions,
    type SessionSort,
    type SessionSortKey,
} from "./sessions-table.ts";
import { money } from "./money.ts";

const WINDOWS: readonly { readonly id: UsageWindowId; readonly label: string }[] = [
    { id: "today", label: "Today" },
    { id: "7d", label: "7 days" },
    { id: "30d", label: "30 days" },
    { id: "all", label: "All" },
];

const PRIOR_LABEL: Readonly<Record<UsageWindowId, string>> = {
    today: "vs previous day",
    "7d": "vs previous 7 days",
    "30d": "vs previous 30 days",
    all: "vs prior",
};

export const ANNEX_PAGES: readonly {
    readonly id: AnnexPageId;
    readonly label: string;
    readonly href: string;
}[] = [
    { id: "usage", label: "Usage", href: "/usage" },
    { id: "runs", label: "Runs", href: "/runs" },
];

export type AnnexPageId = "usage" | "runs";

export function AnnexChrome({
    page,
    onHome,
}: {
    readonly page: AnnexPageId;
    readonly onHome: () => void;
}) {
    const [open, setOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!open) return;
        closeRef.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            toggleRef.current?.focus();
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const close = () => {
        setOpen(false);
        toggleRef.current?.focus();
    };

    return (
        <>
            <div className="top">
                <button
                    ref={toggleRef}
                    className="nav-toggle"
                    type="button"
                    aria-label="Menu"
                    aria-expanded={open}
                    aria-controls="vera-annex-menu"
                    onClick={() => setOpen((current) => !current)}
                >
                    ≡
                </button>
                <div className="brand">
                    Vera <span>· {labelOf(page)}</span>
                </div>
            </div>
            {open
                ? (
                    <>
                        <div className="nav-scrim" onClick={close} />
                        <aside
                            ref={sidebarRef}
                            id="vera-annex-menu"
                            className="nav-sidebar"
                            role="dialog"
                            aria-modal="true"
                            aria-label="Annex"
                        >
                            <div className="nav-sidebar-head">
                                <div className="brand">Vera</div>
                                <button
                                    ref={closeRef}
                                    className="nav-sidebar-close"
                                    type="button"
                                    aria-label="Close menu"
                                    onClick={close}
                                >
                                    ×
                                </button>
                            </div>
                            {ANNEX_PAGES.map((entry) => (
                                entry.id === page
                                    ? (
                                        <button
                                            key={entry.id}
                                            role="menuitem"
                                            type="button"
                                            aria-current="page"
                                            onClick={() => {
                                                close();
                                                onHome();
                                            }}
                                        >
                                            › {entry.label}
                                        </button>
                                    )
                                    : (
                                        <a
                                            key={entry.id}
                                            role="menuitem"
                                            href={entry.href}
                                        >
                                            › {entry.label}
                                        </a>
                                    )
                            ))}
                        </aside>
                    </>
                )
                : undefined}
        </>
    );
}

function labelOf(page: AnnexPageId): string {
    return ANNEX_PAGES.find((entry) => entry.id === page)?.label ?? "Vera";
}

function ModelFilter({
    ids,
    query,
    pin,
    onQuery,
    onPin,
}: {
    readonly ids: readonly string[];
    readonly query: string;
    readonly pin: string | undefined;
    readonly onQuery: (value: string) => void;
    readonly onPin: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);
    const listQuery = modelListQuery(query, pin);
    const visible = ids.filter((id) => modelQueryMatches(id, listQuery));
    const active = visible[Math.min(highlight, Math.max(0, visible.length - 1))];

    useEffect(() => {
        if (pin !== undefined && listQuery.length === 0) {
            const index = ids.indexOf(pin);
            setHighlight(index >= 0 ? index : 0);
            return;
        }
        setHighlight(0);
    }, [ids, listQuery, pin]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        const onPointer = (event: PointerEvent) => {
            const root = rootRef.current;
            if (root !== null && !root.contains(event.target as Node)) {
                event.preventDefault();
                setOpen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onPointer);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pointerdown", onPointer);
        };
    }, [open]);

    const pick = (id: string) => {
        onPin(id);
        setOpen(false);
    };

    const onKeyDown = (event: InputKeyEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) {
                setOpen(true);
                return;
            }
            setHighlight((current) =>
                Math.min(current + 1, Math.max(0, visible.length - 1))
            );
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
                setOpen(true);
                return;
            }
            setHighlight((current) => Math.max(0, current - 1));
            return;
        }
        if (event.key === "Enter" && open && active !== undefined) {
            event.preventDefault();
            pick(active);
        }
        if (event.key === "Escape") {
            setOpen(false);
        }
    };

    return (
        <div className="model-filter" ref={rootRef}>
            <input
                role="combobox"
                aria-expanded={open}
                aria-controls="model-filter-list"
                aria-autocomplete="list"
                aria-activedescendant={open && active !== undefined
                    ? `model-option-${Math.min(highlight, Math.max(0, visible.length - 1))}`
                    : undefined}
                value={query}
                placeholder="Name"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                    onQuery(event.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
            />
            <button
                type="button"
                className="model-filter-toggle"
                aria-label="Model list"
                aria-expanded={open}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setOpen((current) => !current)}
            >
                {open ? "▴" : "▾"}
            </button>
            {open
                ? (
                    <ul
                        id="model-filter-list"
                        className="model-filter-list"
                        role="listbox"
                        aria-label="Models"
                    >
                        {visible.map((id, index) => {
                            const focused = id === active;
                            const mark = focused ? "› " : id === pin ? "· " : "";
                            return (
                                <li
                                    id={`model-option-${index}`}
                                    key={id}
                                    role="option"
                                    aria-selected={focused}
                                    className={focused ? "on" : undefined}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onMouseEnter={() => setHighlight(index)}
                                    onClick={() => pick(id)}
                                >
                                    {mark}{id}
                                </li>
                            );
                        })}
                        {visible.length === 0
                            ? <li className="faint">No models match</li>
                            : undefined}
                    </ul>
                )
                : undefined}
        </div>
    );
}

export function UsageApp() {
    const [windowId, setWindowId] = useState<UsageWindowId>("7d");
    const [report, setReport] = useState<UsageReport | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [loading, setLoading] = useState(true);
    const [sessionId, setSessionId] = useState<string | undefined>();

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(undefined);
        void fetch(`/api/usage?window=${windowId}`, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`usage ${response.status}`);
                }
                return await response.json() as UsageReport;
            })
            .then((next) => {
                setReport(next);
                setLoading(false);
            })
            .catch((failure: unknown) => {
                if (controller.signal.aborted) return;
                setError(failure instanceof Error
                    ? failure.message
                    : String(failure));
                setLoading(false);
            });
        return () => {
            controller.abort();
        };
    }, [windowId]);

    if (sessionId !== undefined) {
        return (
            <SessionDetailPage
                sessionId={sessionId}
                windowId={windowId}
                onBack={() => setSessionId(undefined)}
                onHome={() => setSessionId(undefined)}
            />
        );
    }

    return (
        <div className="page">
            <AnnexChrome page="usage" onHome={() => setSessionId(undefined)} />
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
                {loading
                    ? <p className="note live">Reading session files…</p>
                    : undefined}
            </div>
            {error !== undefined
                ? <p className="note">{error}</p>
                : undefined}
            {report === undefined ? undefined : (
                <Overview
                    report={report}
                    onOpenSession={setSessionId}
                />
            )}
        </div>
    );
}

function Overview({
    report,
    onOpenSession,
}: {
    readonly report: UsageReport;
    readonly onOpenSession: (id: string) => void;
}) {
    const { totals, prior, timeline, models, sessions } = report;
    const [workspace, setWorkspace] = useState("all");
    const [kind, setKind] = useState("all");
    const [modelQuery, setModelQuery] = useState("");
    const [modelPin, setModelPin] = useState<string | undefined>();
    const [sort, setSort] = useState<SessionSort>(DEFAULT_SESSION_SORT);
    const [page, setPage] = useState(0);
    const workspaces = useMemo(() => {
        const names = [...new Set(sessions.map((row) => row.workspaceLabel))].sort();
        return names;
    }, [sessions]);
    const filtered = useMemo(() => sessions.filter((row) => {
        if (workspace !== "all" && row.workspaceLabel !== workspace) return false;
        if (kind !== "all" && row.kind !== kind) return false;
        if (!sessionMatchesModelFilter(row.models ?? [], modelQuery, modelPin)) {
            return false;
        }
        return true;
    }), [sessions, workspace, kind, modelQuery, modelPin]);
    const sorted = useMemo(() => sortSessions(filtered, sort), [filtered, sort]);
    const paged = useMemo(
        () => pageSlice(sorted, page, SESSION_PAGE_SIZE),
        [sorted, page],
    );
    const setFilter = (write: (value: string) => void, value: string) => {
        write(value);
        setPage(0);
    };
    const cycleSort = (key: SessionSortKey) => {
        setSort((current) => nextSessionSort(current, key));
        setPage(0);
    };
    useEffect(() => {
        setPage(0);
    }, [report.window.id]);
    const modelIds = useMemo(
        () => models.map((row) => `${row.provider}/${row.model}`),
        [models],
    );
    const visibleModels = models.filter((row) =>
        modelPin !== undefined
            ? `${row.provider}/${row.model}` === modelPin
            : modelQueryMatches(`${row.provider}/${row.model}`, modelQuery),
    );
    const modelFilterOn = (modelPin !== undefined && modelPin.length > 0)
        || modelQuery.trim().length > 0;
    const showChart = report.window.id !== "today" && timeline.length > 0;
    const priorLabel = PRIOR_LABEL[report.window.id];
    return (
        <>
            <div className="metrics">
                <Metric
                    label="Spend"
                    value={money(totals.spend.combined)}
                    sub={spendSub(totals.spend.reported, totals.spend.unpricedCalls)}
                    delta={deltaMoney(totals.spend.combined, prior?.spend.combined, priorLabel)}
                />
                <Metric
                    label="Requests"
                    value={formatCount(totals.calls)}
                    sub={`${formatCount(totals.calls - totals.spend.unpricedCalls)} priced`}
                    delta={deltaCount(totals.calls, prior?.calls, priorLabel)}
                />
                <Metric
                    label="Tokens"
                    value={formatTokens(totals.totalTokens)}
                    sub={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
                    delta={deltaCount(totals.totalTokens, prior?.totalTokens, priorLabel)}
                />
                <Metric
                    label="Cache hit"
                    value={percent(totals.cacheHitRatio)}
                    sub={`${formatTokens(totals.cachedInputTokens)} input cached`}
                    delta={deltaPoints(totals.cacheHitRatio, prior?.cacheHitRatio, priorLabel)}
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
                        <ModelLegend models={models} />
                    </section>
                )
                : undefined}
            <div className="toolbar filters">
                <label>
                    Workspace
                    <select
                        value={workspace}
                        onChange={(event) => setFilter(setWorkspace, event.target.value)}
                    >
                        <option value="all">All</option>
                        {workspaces.map((name) => (
                            <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Kind
                    <select
                        value={kind}
                        onChange={(event) => setFilter(setKind, event.target.value)}
                    >
                        <option value="all">All</option>
                        <option value="interactive">Chat</option>
                        <option value="subagent">Subagent</option>
                    </select>
                </label>
                <label>
                    Model
                    <ModelFilter
                        ids={modelIds}
                        query={modelQuery}
                        pin={modelPin}
                        onQuery={(value) => {
                            setModelPin(undefined);
                            setFilter(setModelQuery, value);
                        }}
                        onPin={(id) => {
                            setModelPin(id);
                            setFilter(setModelQuery, id);
                        }}
                    />
                </label>
            </div>
            {modelFilterOn
                ? (
                    <section className="table-card">
                        <h2>Models</h2>
                        <ModelTable rows={visibleModels} />
                    </section>
                )
                : undefined}
            <section className="table-card">
                <h2>
                    Sessions
                    <span>
                        {" · total work cost, children included"}
                        {filtered.length !== sessions.length
                            ? ` · showing ${filtered.length} of ${sessions.length}`
                            : sessions.length > 0
                            ? ` · ${sessions.length}`
                            : ""}
                    </span>
                </h2>
                <div className="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <SortHeader
                                    label="Session"
                                    column="title"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                                <SortHeader
                                    label="Workspace"
                                    column="workspace"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                                <SortHeader
                                    label="Kind"
                                    column="kind"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                                <SortHeader
                                    label="Calls"
                                    column="calls"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                                <SortHeader
                                    label="Own"
                                    column="own"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                                <SortHeader
                                    label="Children"
                                    column="children"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                                <SortHeader
                                    label="Cost"
                                    column="cost"
                                    sort={sort}
                                    onSort={cycleSort}
                                />
                            </tr>
                        </thead>
                        <tbody>
                            {paged.rows.map((row) => (
                                <SessionPreview
                                    key={row.id}
                                    row={row}
                                    onOpen={onOpenSession}
                                />
                            ))}
                            {paged.total === 0
                                ? (
                                    <tr>
                                        <td className="faint" colSpan={7}>
                                            {sessions.length === 0
                                                ? "No sessions in this window"
                                                : "No sessions match"}
                                        </td>
                                    </tr>
                                )
                                : undefined}
                        </tbody>
                    </table>
                </div>
                {paged.total > SESSION_PAGE_SIZE
                    ? (
                        <div className="pager">
                            <span>
                                {paged.from}–{paged.to} of {paged.total}
                            </span>
                            <div className="seg">
                                <button
                                    type="button"
                                    disabled={paged.page === 0}
                                    onClick={() => setPage(paged.page - 1)}
                                >
                                    Prev
                                </button>
                                <button
                                    type="button"
                                    disabled={paged.page >= paged.pages - 1}
                                    onClick={() => setPage(paged.page + 1)}
                                >
                                    Next
                                </button>
                            </div>
                        </div>
                    )
                    : undefined}
            </section>
            <div className="footer">
                {money(totals.spend.reported)} reported
                {totals.spend.estimated > 0
                    ? ` · ${money(totals.spend.estimated)} est`
                    : ""}
                {" · "}
                {totals.spend.unpricedCalls} calls still unpriced
            </div>
        </>
    );
}

function SessionDetailPage({
    sessionId,
    windowId,
    onBack,
    onHome,
}: {
    readonly sessionId: string;
    readonly windowId: UsageWindowId;
    readonly onBack: () => void;
    readonly onHome: () => void;
}) {
    const [detail, setDetail] = useState<UsageSessionDetail | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [childId, setChildId] = useState<string | undefined>();

    useEffect(() => {
        const controller = new AbortController();
        setDetail(undefined);
        setError(undefined);
        void fetch(
            `/api/usage/session/${encodeURIComponent(sessionId)}?window=${windowId}`,
            { signal: controller.signal },
        )
            .then(async (response) => {
                if (response.status === 404) {
                    throw new Error("unknown session");
                }
                if (!response.ok) {
                    throw new Error(`usage ${response.status}`);
                }
                return await response.json() as UsageSessionDetail;
            })
            .then((next) => {
                setDetail(next);
            })
            .catch((failure: unknown) => {
                if (controller.signal.aborted) return;
                setError(failure instanceof Error
                    ? failure.message
                    : String(failure));
            });
        return () => {
            controller.abort();
        };
    }, [sessionId, windowId]);

    if (childId !== undefined) {
        return (
            <SessionDetailPage
                sessionId={childId}
                windowId={windowId}
                onBack={() => setChildId(undefined)}
                onHome={onHome}
            />
        );
    }

    const session = detail?.session;
    return (
        <div className="page">
            <AnnexChrome page="usage" onHome={onHome} />
            <button className="back" type="button" onClick={onBack}>
                ← Usage
            </button>
            {error !== undefined ? <p className="note">{error}</p> : undefined}
            {detail === undefined && error === undefined
                ? <p className="note">Reading session…</p>
                : undefined}
            {session === undefined || detail === undefined ? undefined : (
                <>
                    <div className="detail-head">
                        <h1>{session.title}</h1>
                        <div className="meta">
                            {session.workspaceLabel}
                            {" · "}
                            {kindLabel(session.kind)}
                            {" · "}
                            {session.calls} own calls
                            {session.children > 0
                                ? ` · children ${money(session.children)}`
                                : ""}
                        </div>
                    </div>
                    <div className="metrics">
                        <Metric
                            label="Total work"
                            value={money(session.combined)}
                            sub="own + children"
                        />
                        <Metric
                            label="Own"
                            value={money(session.own)}
                            sub="this conversation"
                        />
                        <Metric
                            label="Children"
                            value={money(session.children)}
                            sub={`${detail.children.length} launched`}
                        />
                        <Metric
                            label="Calls"
                            value={formatCount(detail.totals.calls)}
                            sub="this work"
                        />
                        <Metric
                            label="Unpriced"
                            value={formatCount(detail.totals.spend.unpricedCalls)}
                            sub="no dollar yet"
                        />
                    </div>
                    <section className="table-card">
                        <h2>Models in this work</h2>
                        <ModelTable rows={detail.models} tools />
                    </section>
                    {detail.children.length > 0
                        ? (
                            <section className="table-card">
                                <h2>Children</h2>
                                <div className="table-scroll">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Session</th>
                                                <th>Kind</th>
                                                <th>Cost</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {detail.children.map((row) => (
                                                <tr
                                                    key={row.id}
                                                    className="click"
                                                    onClick={() => setChildId(row.id)}
                                                >
                                                    <td>{row.title}</td>
                                                    <td className="dim">
                                                        {kindLabel(row.kind)}
                                                    </td>
                                                    <td>
                                                        {costCell(row.combined, row.costKind)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        )
                        : undefined}
                    <section className="table-card">
                        <h2>Calls <span>· this conversation only</span></h2>
                        <div className="table-scroll">
                            <table>
                                <thead>
                                    <tr>
                                        <th>When</th>
                                        <th>Model</th>
                                        <th>Kind</th>
                                        <th>Tools</th>
                                        <th>Cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {detail.calls.map((call, index) => (
                                        <CallRow key={`${call.timestamp}-${index}`} call={call} />
                                    ))}
                                    {detail.calls.length === 0
                                        ? (
                                            <tr>
                                                <td className="faint" colSpan={5}>
                                                    No calls in this window
                                                </td>
                                            </tr>
                                        )
                                        : undefined}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}

function SortHeader({
    label,
    column,
    sort,
    onSort,
}: {
    readonly label: string;
    readonly column: SessionSortKey;
    readonly sort: SessionSort;
    readonly onSort: (key: SessionSortKey) => void;
}) {
    const active = sort.key === column;
    const marker = active ? (sort.dir === "asc" ? "▲" : "▼") : "";
    return (
        <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
            <button
                type="button"
                className="th-sort"
                onClick={() => onSort(column)}
            >
                {label}
                {marker === "" ? undefined : <span className="sort-mark">{marker}</span>}
            </button>
        </th>
    );
}

function CallRow({ call }: { readonly call: UsageCallRow }) {
    return (
        <tr>
            <td className="dim">{callTime(call.timestamp)}</td>
            <td className="mono">{call.provider}/{call.model}</td>
            <td className="dim">{call.kind}</td>
            <td className="dim">{call.tools.join(" · ") || "—"}</td>
            <td>{costCell(call.cost, call.costKind)}</td>
        </tr>
    );
}

function SessionPreview({
    row,
    onOpen,
}: {
    readonly row: UsageSessionRow;
    readonly onOpen: (id: string) => void;
}) {
    return (
        <tr className="click" onClick={() => onOpen(row.id)}>
            <td className="title" title={row.title}>{row.title}</td>
            <td className="ws">{row.workspaceLabel}</td>
            <td className="dim">{kindLabel(row.kind)}</td>
            <td className="dim">{row.calls}</td>
            <td className="dim">{money(row.own)}</td>
            <td className="dim">
                {row.children > 0 ? money(row.children) : "—"}
            </td>
            <td>{costCell(row.combined, row.costKind)}</td>
        </tr>
    );
}

function ModelTable({
    rows,
    tools = false,
}: {
    readonly rows: readonly UsageModelRow[];
    readonly tools?: boolean;
}) {
    const shown = rows.slice(0, 8);
    const rest = rows.slice(8);
    const restSpend = rest.reduce((sum, row) => sum + row.spend, 0);
    const restShare = rest.reduce((sum, row) => sum + row.share, 0);
    return (
        <div className="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th>Model</th>
                        <th>Share</th>
                        <th>Cost</th>
                        {tools ? <th>Tools</th> : undefined}
                    </tr>
                </thead>
                <tbody>
                    {shown.map((row) => (
                        <tr key={`${row.provider}/${row.model}`}>
                            <td className="mono">
                                {row.provider}/{row.model}
                            </td>
                            <td>{shareCell(row.share)}</td>
                            <td>{costCell(row.spend, row.kind)}</td>
                            {tools
                                ? <td className="dim">{toolMix(row.tools)}</td>
                                : undefined}
                        </tr>
                    ))}
                    {rest.length > 0
                        ? (
                            <tr>
                                <td className="faint">Other ({rest.length})</td>
                                <td>{shareCell(restShare)}</td>
                                <td>{money(restSpend)}</td>
                                {tools ? <td /> : undefined}
                            </tr>
                        )
                        : undefined}
                    {rows.length === 0
                        ? (
                            <tr>
                                <td className="faint" colSpan={tools ? 4 : 3}>
                                    No priced calls in this window
                                </td>
                            </tr>
                        )
                        : undefined}
                </tbody>
            </table>
        </div>
    );
}

function ModelLegend({ models }: { readonly models: readonly UsageModelRow[] }) {
    const top = models.slice(0, 3);
    if (top.length === 0) return null;
    return (
        <ul className="legend">
            {top.map((row, index) => (
                <li key={`${row.provider}/${row.model}`}>
                    <i className={`swatch m${index}`} />
                    {row.provider}/{row.model}
                    <span>{money(row.spend)}</span>
                </li>
            ))}
            {models.length > 3
                ? (
                    <li>
                        <i className="swatch rest" />
                        Other
                    </li>
                )
                : undefined}
        </ul>
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
    const dated = timeline.length > 10;
    return (
        <div className="chart">
            <div className="axis">
                <span>{money(peak)}</span>
                <span>$0</span>
            </div>
            <div className="chart-body">
                <div className="bars">
                    {timeline.map((point) => (
                        <div
                            className="col"
                            key={point.date}
                            title={`${point.date} · ${money(point.spend)}`}
                        >
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
                            <div className="day">{chartLabel(point.date, dated)}</div>
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
    return ["m0", "m1", "m2", "rest"][index < 0 ? 3 : index] ?? "rest";
}

function chartLabel(date: string, dated: boolean): string {
    const parts = date.split("-");
    const day = Number(parts[2]);
    if (!Number.isFinite(day)) return date.slice(5);
    const asDate = new Date(Number(parts[0]), Number(parts[1]) - 1, day);
    if (dated) {
        return `${String(asDate.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return asDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "numeric",
        day: "numeric",
    });
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

function costCell(
    amount: number,
    kind: UsageModelRow["kind"] | UsageSessionRow["costKind"] | UsageCallRow["costKind"],
) {
    if (kind === "unpriced" && amount === 0) {
        return <span className="faint">—</span>;
    }
    if (kind === "estimated") {
        return <span className="est">{money(amount)} est</span>;
    }
    if (kind === "mixed") {
        return <span>{money(amount)} mixed</span>;
    }
    return money(amount);
}

function toolMix(tools: readonly UsageToolCount[]): string {
    if (tools.length === 0) return "—";
    const top = tools.slice(0, 3);
    const more = tools.length - top.length;
    const text = top.map((row) => `${row.name} ${row.calls}`).join(" · ");
    return more > 0 ? `${text} · ${more} more` : text;
}

function spendSub(reported: number, unpriced: number): string {
    const bits = [`${money(reported)} reported`];
    if (unpriced > 0) bits.push(`${unpriced} unpriced`);
    return bits.join(" · ");
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

function kindLabel(kind: UsageSessionRow["kind"]): string {
    return kind === "subagent" ? "sub" : "chat";
}

function callTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return timestamp;
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function deltaMoney(
    current: number,
    prior: number | undefined,
    label: string,
): string | undefined {
    if (prior === undefined) return undefined;
    const diff = current - prior;
    const sign = diff >= 0 ? "+" : "−";
    return `${sign}${money(Math.abs(diff))} ${label}`;
}

function deltaCount(
    current: number,
    prior: number | undefined,
    label: string,
): string | undefined {
    if (prior === undefined || prior === 0) return undefined;
    const pct = Math.round((current - prior) / prior * 100);
    const sign = pct >= 0 ? "+" : "−";
    return `${sign}${Math.abs(pct)}% ${label}`;
}

function deltaPoints(
    current: number,
    prior: number | undefined,
    label: string,
): string | undefined {
    if (prior === undefined) return undefined;
    const pts = Math.round((current - prior) * 100);
    const sign = pts >= 0 ? "+" : "−";
    return `${sign}${Math.abs(pts)} pts ${label}`;
}
