import { useEffect, useState, useSyncExternalStore } from "react";

import { historyVersion, listVisits, subscribeHistory, type HistoryPage } from "./history.ts";

export function useBrowserHistory() {
    const version = useSyncExternalStore(subscribeHistory, historyVersion, historyVersion);
    const [query, setQuery] = useState("");
    const [page, setPage] = useState<HistoryPage>(() => listVisits("", 0));

    useEffect(() => {
        setPage(listVisits(query, 0));
    }, [query, version]);

    const showMore = (): void => {
        const next = listVisits(query, page.entries.length);
        setPage({ entries: [...page.entries, ...next.entries], hasMore: next.hasMore });
    };

    return { query, setQuery, page, showMore };
}
