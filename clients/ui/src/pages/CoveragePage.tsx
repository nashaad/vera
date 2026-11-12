import { useState } from "react";

import { CheckIcon, PlayIcon } from "../components/Icons.tsx";
import { COVERAGE } from "./coverage-data.ts";
import {
    coverageCounts,
    filterPhases,
    segmentPercent,
    STATUS_LABELS,
    STATUS_ORDER,
    windowPercent,
    type CoverageFilter,
} from "./coverage.ts";
import { EmptyState, Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";

export function CoveragePage() {
    const { navigate } = useRouter();
    const [filter, setFilter] = useState<CoverageFilter>("all");
    const counts = coverageCounts(COVERAGE);
    const phases = filterPhases(COVERAGE, filter);

    return (
        <Page
            title="Coverage"
            lede="Each step of a session, one line per behavior, with what this window does at that step. Terminal only means the terminal client does it and this window does not; the note names how."
            Icon={CheckIcon}
            wide
            actions={(
                <button type="button" className="ghost-btn" onClick={() => navigate({ kind: "tour" })}>
                    <PlayIcon />
                    Tour
                </button>
            )}
        >

            <div className="coverage-bar" role="img" aria-label={`${windowPercent(counts)}% of behaviors in the window`}>
                {STATUS_ORDER.map((status) => (
                    <span
                        key={status}
                        className="coverage-segment"
                        data-status={status}
                        style={{ width: `${segmentPercent(counts, status)}%` }}
                    />
                ))}
            </div>

            <div className="toolbar">
                <button
                    type="button"
                    className="filter-pill"
                    aria-pressed={filter === "all"}
                    onClick={() => setFilter("all")}
                >
                    All <span className="coverage-count">{counts.total}</span>
                </button>
                {STATUS_ORDER.map((status) => (
                    <button
                        key={status}
                        type="button"
                        className="filter-pill"
                        aria-pressed={filter === status}
                        onClick={() => setFilter(status)}
                    >
                        <span className="coverage-dot" data-status={status} />
                        {STATUS_LABELS[status]}
                        <span className="coverage-count">{counts[status]}</span>
                    </button>
                ))}
                <span className="coverage-pct">{windowPercent(counts)}% in the window</span>
            </div>

            {phases.map((phase) => (
                <div key={phase.name}>
                    <h2 className="section-title">
                        {phase.name} <span className="section-count">{phase.items.length}</span>
                    </h2>
                    <div className="coverage-list">
                        {phase.items.map((item) => (
                            <div key={`${phase.name}/${item.text}`} className="coverage-row" data-status={item.status}>
                                <span
                                    className="coverage-dot"
                                    data-status={item.status}
                                    title={STATUS_LABELS[item.status]}
                                />
                                <span className="coverage-text">{item.text}</span>
                                {item.note !== undefined && <span className="coverage-note">{item.note}</span>}
                            </div>
                        ))}
                    </div>
                </div>
            ))}

            {phases.length === 0 && (
                <EmptyState title="Nothing here">
                    {COVERAGE.length === 0 ? "No behaviors are listed." : "No behavior has this status."}
                </EmptyState>
            )}
        </Page>
    );
}
