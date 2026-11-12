import { Fragment, useEffect, useRef, useState } from "react";

import { ChevronRightIcon, SearchIcon } from "../components/Icons.tsx";
import type { SessionSearchResult } from "../protocol/bridge.ts";
import { folderName } from "../protocol/sessionGroups.ts";
import { relativeTime } from "../protocol/sessions.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { EmptyState, Page } from "./Page.tsx";
import { useRouter } from "./router.tsx";
import {
    inScope,
    markSnippet,
    mergeMatches,
    sameSearch,
    titleMatches,
    workspaceChoices,
    type SearchFilter,
    type SearchKey,
    type SearchRow,
} from "./search.ts";

const SEARCH_DEBOUNCE_MS = 200;

type Scope = "everything" | "conversation";

interface HostAnswer extends SearchKey {
    readonly result: SessionSearchResult;
}

export function SearchPage() {
    const { connection } = useViewEnvironment();
    const { navigate, lastSession } = useRouter();
    const rows = connection.sessionRows ?? [];
    const choices = workspaceChoices(rows);
    const now = Date.now();

    const [typed, setTyped] = useState("");
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<Scope>("everything");
    const [chosenWorkspace, setChosenWorkspace] = useState<string | undefined>(undefined);
    const [answer, setAnswer] = useState<HostAnswer | undefined>(undefined);
    const requests = useRef(0);

    // The conversation scope needs an open session; without one it falls back to everything.
    const conversationId = scope === "conversation" ? lastSession?.agentId : undefined;
    const workspace = conversationId === undefined && chosenWorkspace !== undefined
        && choices.some((choice) => choice.workspace === chosenWorkspace)
        ? chosenWorkspace
        : undefined;
    const filter: SearchFilter = { workspace, agentId: conversationId };
    const current: SearchKey = { query: query.trim(), ...filter };

    useEffect(() => {
        const timer = window.setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [typed]);

    useEffect(() => {
        const id = requests.current + 1;
        requests.current = id;
        const bridge = window.veraDesktop;
        if (query.length === 0) return;
        const land = (result: SessionSearchResult) => {
            if (requests.current === id) setAnswer({ query, workspace, agentId: conversationId, result });
        };
        if (bridge === undefined) {
            land({ ok: false, reason: "This window has no host bridge." });
            return;
        }
        bridge.searchSessions({
            query,
            ...(workspace === undefined ? {} : { workspace }),
            ...(conversationId === undefined ? {} : { agentId: conversationId }),
        }).then(land, () => land({ ok: false, reason: "The search did not finish." }));
    }, [query, workspace, conversationId]);

    const hostMatches = answer !== undefined && answer.result.ok
        ? answer.result.matches.filter((match) => inScope(match.agentId, match.workspace, filter))
        : [];
    const results: readonly SearchRow[] = query.length === 0
        ? []
        : mergeMatches(hostMatches, titleMatches(rows, query, filter));
    const pending = query.length > 0 && (answer === undefined || !sameSearch(answer, current));
    const failure = query.length > 0 && answer !== undefined && answer.result.ok === false ? answer.result.reason : undefined;
    const truncated = query.length > 0 && answer !== undefined && answer.result.ok && answer.result.truncated;
    const statusById = new Map(rows.map((row) => [row.id, row.status]));

    return (
        <Page title="Search" lede="Search every session by title and by what was said inside it.">
            <div className="toolbar">
                <label className="search-field">
                    <SearchIcon />
                    <input
                        type="search"
                        aria-label="Search sessions"
                        placeholder="Search sessions"
                        autoFocus
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                    />
                </label>
            </div>

            <div className="toolbar">
                <button
                    type="button"
                    className="filter-pill"
                    aria-pressed={conversationId === undefined}
                    onClick={() => setScope("everything")}
                >
                    Everything
                </button>
                <button
                    type="button"
                    className="filter-pill"
                    aria-pressed={conversationId !== undefined}
                    disabled={lastSession === undefined}
                    title={lastSession === undefined ? "Open a session first" : undefined}
                    onClick={() => setScope("conversation")}
                >
                    This conversation
                </button>
            </div>

            {conversationId === undefined && (
                <div className="toolbar">
                    <button
                        type="button"
                        className="filter-pill"
                        aria-pressed={workspace === undefined}
                        onClick={() => setChosenWorkspace(undefined)}
                    >
                        All workspaces
                    </button>
                    {choices.map((choice) => (
                        <button
                            key={choice.workspace}
                            type="button"
                            className="filter-pill"
                            aria-pressed={workspace === choice.workspace}
                            title={choice.workspace}
                            onClick={() => setChosenWorkspace(choice.workspace)}
                        >
                            {choice.label}
                        </button>
                    ))}
                </div>
            )}

            {failure !== undefined && <p className="search-note">{failure}</p>}
            {truncated && <p className="search-note">Showing the first 20 sessions that match. Add words to narrow it.</p>}

            {query.length === 0 ? (
                <EmptyState title="Type to search">Search finds a session by its title or by what was said in it.</EmptyState>
            ) : results.length === 0 ? (
                pending ? null : <EmptyState title="No matches">{`No session mentions “${query}”.`}</EmptyState>
            ) : (
                <ul className="list">
                    {results.map((row) => {
                        const snippet = row.hits[0]?.snippet;
                        const age = row.updatedAt === undefined ? "" : relativeTime(row.updatedAt, now);
                        const status = statusById.get(row.agentId);
                        const running = status === "working" || status === "waiting";
                        return (
                            <li key={row.agentId}>
                                <button
                                    type="button"
                                    className="list-row"
                                    data-session={row.agentId}
                                    onClick={() => navigate({ kind: "session", agentId: row.agentId, title: row.title })}
                                >
                                    <span className="session-dot" data-running={running} aria-hidden="true" />
                                    <span className="list-row-body">
                                        <span className="list-row-name">
                                            <span className="list-row-title">{row.title}</span>
                                            <span className="badge" title={row.workspace}>{folderName(row.workspace)}</span>
                                        </span>
                                        {snippet !== undefined && snippet.length > 0 && (
                                            <span className="list-row-detail search-snippet">
                                                {markSnippet(snippet, query).map((segment, index) => segment.marked
                                                    ? <mark key={index} className="search-mark">{segment.text}</mark>
                                                    : <Fragment key={index}>{segment.text}</Fragment>)}
                                            </span>
                                        )}
                                    </span>
                                    {age !== "" && <span className="list-row-age">{age}</span>}
                                    <ChevronRightIcon className="list-row-go" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </Page>
    );
}
