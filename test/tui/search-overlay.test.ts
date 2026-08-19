import { expect, test } from "bun:test";

import {
    applySearchFailure,
    applySearchResults,
    handleSearchOverlayKey,
    searchOverlayFooter,
    searchOverlayHeader,
    searchOverlayLines,
    searchOverlayQuery,
    searchSelections,
    searchOverlayText,
    startSearchOverlay,
    type SearchOverlayState,
} from "../../clients/tui/search-overlay.ts";
import type {
    SessionSearchResults,
} from "../../src/store/session-search.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function typing(query: string): SearchOverlayState {
    let state = startSearchOverlay("/work/one");
    for (const character of query) {
        const transition = handleSearchOverlayKey(state, {
            name: character === " " ? "space" : character,
        });
        state = transition.state ?? state;
    }
    return state;
}

function results(): SessionSearchResults {
    return {
        truncated: false,
        results: [
            {
                session_id: "relay-gui",
                session_path: "/sessions/relay-gui.jsonl",
                title: "relay-gui",
                workspace: "/work/one",
                updated_at: "2026-08-14T10:00:00.000Z",
                hits: [{
                    kind: "user_message",
                    snippet: "if the provider fallback kicks in, does the sidebar",
                    entry_id: "entry-3",
                }],
            },
            {
                session_id: "provider-fallback",
                session_path: "/sessions/provider-fallback.jsonl",
                title: "provider-fallback",
                workspace: "/work/one",
                updated_at: "2026-08-13T10:00:00.000Z",
                hits: [
                    {
                        kind: "agent_message",
                        snippet: "the fallback ladder degrades in place",
                        entry_id: "entry-9",
                    },
                    {
                        kind: "tool_command",
                        snippet: "bun test tests/unit/fallback",
                        entry_id: "entry-10",
                    },
                ],
            },
        ],
    };
}

test("typing builds a query scoped to this workspace by default", () => {
    const state = typing("provider fallback");

    expect(state.query).toBe("provider fallback");
    expect(searchOverlayQuery(state))
        .toEqual({ query: "provider fallback", workspace: "/work/one" });
    expect(searchOverlayHeader(state)).toBe("Search · all · this workspace");
});

test("each keystroke asks for a search and keeps the old results as stale", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    expect(state.results?.results).toHaveLength(2);

    const next = handleSearchOverlayKey(state, { name: "s" });
    expect(next.action).toEqual({
        kind: "search",
        query: { query: "fallbacks", workspace: "/work/one" },
    });
    expect(next.state?.results?.results).toHaveLength(2);
    expect(next.state?.searching).toBe(true);

    const lines = searchOverlayLines(next.state ?? state, {
        width: 78,
        now: NOW,
    });
    const resultLines = lines.filter((line) => line.kind === "result"
        || line.kind === "hit");
    expect(resultLines.length).toBeGreaterThan(0);
    expect(resultLines.every((line) => line.stale === true)).toBe(true);
});

test("clearing the query back to empty drops the stale results", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );

    let cleared = state;
    for (let press = 0; press < "fallback".length; press += 1) {
        cleared = handleSearchOverlayKey(cleared, { name: "backspace" })
            .state ?? cleared;
    }
    expect(cleared.results).toBeUndefined();
    expect(searchOverlayText(cleared, { width: 78, now: NOW }))
        .toContain("Type to search past work.");
});

test("tab cycles the filter and asks again", () => {
    let state = typing("fallback");
    const seen: (string | undefined)[] = [state.filter];
    for (let press = 0; press < 4; press += 1) {
        const transition = handleSearchOverlayKey(state, { name: "tab" });
        state = transition.state ?? state;
        seen.push(state.filter);
        expect(transition.action?.kind).toBe("search");
    }

    expect(seen).toEqual([
        undefined,
        "messages",
        "tools",
        "files",
        undefined,
    ]);
    expect(searchOverlayHeader({ ...state, filter: "tools" }))
        .toBe("Search · tools · this workspace");
});

test("the scope toggle widens past this workspace and says so", () => {
    const state = typing("fallback");
    const widened = handleSearchOverlayKey(state, { name: "w", ctrl: true });

    expect(widened.state?.scope).toBe("everywhere");
    expect(searchOverlayQuery(widened.state ?? state))
        .toEqual({ query: "fallback" });
    expect(searchOverlayHeader(widened.state ?? state))
        .toBe("Search · all · everywhere");

    const narrowed = handleSearchOverlayKey(widened.state ?? state, {
        name: "w",
        ctrl: true,
    });
    expect(narrowed.state?.scope).toBe("workspace");
});

test("results group by session with a prefix naming each hit kind", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    const text = searchOverlayText(state, { width: 78, now: NOW });

    expect(text).toContain("relay-gui");
    expect(text).toContain("you: if the provider fallback kicks in");
    expect(text).toContain("agent: the fallback ladder degrades in place");
    expect(text).toContain("ran: bun test tests/unit/fallback");
});

test("a file hit is prefixed as an edit", () => {
    const state = applySearchResults(
        typing("ladder"),
        { query: "ladder", workspace: "/work/one" },
        {
            truncated: false,
            results: [{
                session_id: "memory-retrieval",
                session_path: "/sessions/memory.jsonl",
                title: "memory-retrieval",
                workspace: "/work/one",
                updated_at: "2026-08-09T10:00:00.000Z",
                hits: [{
                    kind: "file_edit",
                    snippet: "src/extensions/fallback/ladder.ts",
                    entry_id: "entry-1",
                }],
            }],
        },
    );

    expect(searchOverlayText(state, { width: 78, now: NOW }))
        .toContain("edited: src/extensions/fallback/ladder.ts");
});

test("no line is wider than the terminal", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );

    for (const width of [78, 42]) {
        for (const line of searchOverlayLines(state, { width, now: NOW })) {
            expect(line.text.length, `${width}: ${line.text}`)
                .toBeLessThanOrEqual(width);
        }
    }
});

test("enter opens the selected session at its match, not its tail", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    expect(state.selected).toEqual({ sessionId: "relay-gui", hitIndex: 0 });

    expect(handleSearchOverlayKey(state, { name: "return" }).action).toEqual({
        kind: "open",
        session_id: "relay-gui",
        session_path: "/sessions/relay-gui.jsonl",
        entry_id: "entry-3",
    });

    const moved = handleSearchOverlayKey(state, { name: "down" }).state ?? state;
    expect(handleSearchOverlayKey(moved, { name: "return" }).action).toEqual({
        kind: "open",
        session_id: "provider-fallback",
        session_path: "/sessions/provider-fallback.jsonl",
        entry_id: "entry-9",
    });
});

test("every hit is reachable, not only the first in each session", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );

    // The fixture holds one hit in the first session and two in the second.
    // The second session's second hit is somewhere else in that transcript,
    // so a cursor that stopped at sessions would leave it on screen and
    // unreachable.
    expect(searchSelections(state)).toEqual([
        { sessionId: "relay-gui", hitIndex: 0 },
        { sessionId: "provider-fallback", hitIndex: 0 },
        { sessionId: "provider-fallback", hitIndex: 1 },
    ]);

    let walked = state;
    for (let press = 0; press < 2; press += 1) {
        walked = handleSearchOverlayKey(walked, { name: "down" }).state ?? walked;
    }
    expect(handleSearchOverlayKey(walked, { name: "return" }).action).toEqual({
        kind: "open",
        session_id: "provider-fallback",
        session_path: "/sessions/provider-fallback.jsonl",
        entry_id: "entry-10",
    });

    // And it clamps there rather than wrapping to the top.
    const past = handleSearchOverlayKey(walked, { name: "down" }).state ?? walked;
    expect(past.selected).toEqual({
        sessionId: "provider-fallback",
        hitIndex: 1,
    });
});

test("the selection sits on the hit, not on the session above it", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    const lines = searchOverlayLines(state, { width: 78, now: NOW });

    const selected = lines.filter((line) => line.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.kind).toBe("hit");
    expect(selected[0]?.text).toContain("you:");
});

test("enter with nothing selected does nothing rather than opening at random", () => {
    const transition = handleSearchOverlayKey(typing("fallback"), {
        name: "return",
    });

    expect(transition.action).toBeUndefined();
    expect(transition.handled).toBe(true);
});

test("escape closes", () => {
    expect(handleSearchOverlayKey(typing("x"), { name: "escape" }).action)
        .toEqual({ kind: "close" });
});

test("ctrl chords are passed through so the global bindings still fire", () => {
    const transition = handleSearchOverlayKey(typing("x"), {
        name: "c",
        ctrl: true,
    });

    expect(transition.handled).toBe(false);
    expect(transition.action).toBeUndefined();
});

test("results for a query that has moved on are dropped", () => {
    const state = typing("fallback");
    const stale = applySearchResults(
        state,
        { query: "fall", workspace: "/work/one" },
        results(),
    );

    expect(stale.results).toBeUndefined();
    expect(stale).toEqual(state);
});

test("a failure states itself instead of showing an empty result", () => {
    const state = applySearchFailure(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        "This host has no session directory to search",
    );

    expect(state.results).toBeUndefined();
    expect(searchOverlayText(state, { width: 78, now: NOW }))
        .toContain("no session directory");
});

test("empty, searching, and no-match all read as themselves", () => {
    const empty = startSearchOverlay("/work/one");
    expect(searchOverlayText(empty, { width: 78, now: NOW }))
        .toContain("Type to search past work.");

    expect(searchOverlayText(typing("fallback"), { width: 78, now: NOW }))
        .toContain("Searching…");

    const none = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        { results: [], truncated: false },
    );
    expect(searchOverlayText(none, { width: 78, now: NOW }))
        .toContain("No matches.");
});

test("a truncated result set says it was truncated", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        { ...results(), truncated: true },
    );

    expect(searchOverlayText(state, { width: 78, now: NOW }))
        .toContain("narrow the search");
});

test("the footer shortens with the terminal", () => {
    expect(searchOverlayFooter(78)).toContain("enter open at match");
    expect(searchOverlayFooter(42)).toBe("↑↓ enter tab ^w esc");
});
