import { useLayoutEffect, useRef } from "react";

import { clearHistory, type HistoryEntry } from "../browser/history.ts";
import { useBrowserHistory } from "../browser/useBrowserHistory.ts";

interface BrowserHistoryProps {
    readonly focusClear: number;
    readonly open: (url: string) => void;
}

interface HistoryDay {
    readonly label: string;
    readonly entries: HistoryEntry[];
}

function groupByDay(entries: readonly HistoryEntry[]): readonly HistoryDay[] {
    const groups: HistoryDay[] = [];
    for (const entry of entries) {
        const label = new Date(entry.visitedAt).toLocaleDateString(undefined, { dateStyle: "full" });
        let group = groups.at(-1);
        if (group === undefined || group.label !== label) {
            group = { label, entries: [] };
            groups.push(group);
        }
        group.entries.push(entry);
    }
    return groups;
}

export function BrowserHistory({ focusClear, open }: BrowserHistoryProps) {
    const { query, setQuery, page, showMore } = useBrowserHistory();
    const clear = useRef<HTMLButtonElement>(null);

    useLayoutEffect(() => {
        if (focusClear > 0) clear.current?.focus();
    }, [focusClear]);

    return (
        <section className="browser-history" aria-label="History">
            <div className="browser-history-header">
                <h2>History</h2>
                <input
                    type="search"
                    aria-label="Search history"
                    placeholder="Search history"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
                <button type="button" ref={clear} onClick={clearHistory}>Clear</button>
            </div>
            <div className="browser-history-list">
                {page.entries.length === 0 ? <p className="view-empty">No history found.</p> : null}
                {groupByDay(page.entries).map((group) => (
                    <section key={group.label} className="browser-history-day">
                        <h3>{group.label}</h3>
                        {group.entries.map((entry, index) => (
                            <button
                                type="button"
                                className="browser-history-entry"
                                key={`${entry.visitedAt}:${entry.url}:${index}`}
                                onClick={() => open(entry.url)}
                            >
                                <span className="browser-history-entry-text">
                                    <span className="browser-history-title">{entry.title || entry.url}</span>
                                    <span className="browser-history-url">{entry.url}</span>
                                </span>
                                <time dateTime={new Date(entry.visitedAt).toISOString()}>
                                    {new Date(entry.visitedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                                </time>
                            </button>
                        ))}
                    </section>
                ))}
                {page.hasMore ? <button type="button" className="browser-history-more" onClick={showMore}>Show more</button> : null}
            </div>
        </section>
    );
}
