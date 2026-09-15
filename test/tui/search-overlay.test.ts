import { expect, test } from "bun:test";

import {
    applySearchFailure,
    applySearchResults,
    handleSearchOverlayKey,
    searchOverlayFooter,
    searchOverlayHeader,
    searchOverlayLines,
    searchOverlayQuery,
    searchOverlayViewState,
    SEARCH_PAGE,
    searchSelections,
    searchOverlayText,
    startSearchOverlay,
    updateSearchOverlayText,
    type SearchOverlayState,
} from "../../clients/tui/search-overlay.ts";
import type {
    SessionSearchResults,
} from "../../src/store/session-search.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function typing(query: string): SearchOverlayState {
    const state = startSearchOverlay("/work/one");
    return updateSearchOverlayText(state, query).state ?? state;
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
    expect(searchOverlayHeader(state)).toBe("Search · this workspace");
});

test("search edits and re-queries at the caret", () => {
    const corrected = updateSearchOverlayText(typing("fallbak"), "fallback", 7);

    expect(corrected.state?.query).toBe("fallback");
    expect(corrected.state?.queryCursor).toBe(7);
    expect(corrected.action).toEqual({
        kind: "search",
        query: { query: "fallback", workspace: "/work/one" },
    });
});

test("search paste asks once with the inserted query", () => {
    const transition = updateSearchOverlayText(
        startSearchOverlay("/work/one"),
        "provider fallback",
    );
    expect(transition.action).toEqual({
        kind: "search",
        query: { query: "provider fallback", workspace: "/work/one" },
    });
});

test("each keystroke asks for a search and keeps the old results as stale", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    expect(state.results?.results).toHaveLength(2);

    const next = updateSearchOverlayText(state, "fallbacks");
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

    const cleared = updateSearchOverlayText(state, "").state ?? state;
    expect(cleared.results).toBeUndefined();
    expect(searchOverlayText(cleared, { width: 78, now: NOW }))
        .toContain("Type to search past work.");
});

test("tab walks search, the filter chip and results, and wraps", () => {
    let state = typing("fallback");
    const seen: string[] = [state.focus];
    for (let press = 0; press < 3; press += 1) {
        const transition = handleSearchOverlayKey(state, { name: "tab" });
        expect(transition.handled).toBe(true);
        expect(transition.action).toBeUndefined();
        state = transition.state ?? state;
        seen.push(state.focus);
    }
    expect(seen).toEqual(["search", "filter", "results", "search"]);

    const back = handleSearchOverlayKey(state, { name: "tab", shift: true });
    expect(back.state?.focus).toBe("results");
});

test("the search box keeps left and right for its caret", () => {
    const state = typing("fallback");
    for (const name of ["left", "right", "space"]) {
        expect(handleSearchOverlayKey(state, { name }).handled).toBe(false);
    }
    expect(handleSearchOverlayKey(state, { name: "down" }).state?.focus)
        .toBe("filter");
    expect(handleSearchOverlayKey(state, { name: "up" }).state?.focus)
        .toBe("results");
});

test("the chip owns no arrows and opens its menu on space or enter", () => {
    const chip: SearchOverlayState = { ...typing("fallback"), focus: "filter" };
    expect(handleSearchOverlayKey(chip, { name: "down" }).state?.focus)
        .toBe("results");
    expect(handleSearchOverlayKey(chip, { name: "right" }).state?.focus)
        .toBe("results");
    expect(handleSearchOverlayKey(chip, { name: "left" }).state?.focus)
        .toBe("search");

    for (const name of ["space", "return"]) {
        const opened = handleSearchOverlayKey(chip, { name });
        expect(opened.state?.filterMenu).toBe(0);
        expect(opened.action).toBeUndefined();
    }
});

test("picking from the filter menu asks again and closes the menu", () => {
    let state: SearchOverlayState = {
        ...typing("fallback"),
        focus: "filter",
        filterMenu: 0,
    };
    state = handleSearchOverlayKey(state, { name: "down" }).state ?? state;
    state = handleSearchOverlayKey(state, { name: "down" }).state ?? state;
    expect(searchOverlayViewState(state, 78, NOW).footer).toContain("enter pick");

    const picked = handleSearchOverlayKey(state, { name: "return" });
    expect(picked.state?.filter).toBe("tools");
    expect(picked.state?.filterMenu).toBeUndefined();
    expect(picked.state?.focus).toBe("filter");
    expect(picked.action).toEqual({
        kind: "search",
        query: { query: "fallback", kind: "tools", workspace: "/work/one" },
    });

    const view = searchOverlayViewState(picked.state ?? state, 78, NOW);
    expect(view.chip).toEqual({ text: "Filter: tools ▾", focused: true });

    const closed = handleSearchOverlayKey(
        { ...(picked.state ?? state), filterMenu: 3 },
        { name: "escape" },
    );
    expect(closed.action).toBeUndefined();
    expect(closed.state?.filterMenu).toBeUndefined();
    expect(closed.state?.filter).toBe("tools");
});

test("typing from the chip or the results goes to the search box", () => {
    for (const focus of ["filter", "results"] as const) {
        const state: SearchOverlayState = { ...typing("fall"), focus };
        const transition = handleSearchOverlayKey(state, {
            name: "b",
            sequence: "b",
        });
        expect(transition.handled).toBe(false);
        expect(transition.state?.focus).toBe("search");
    }
});

test("only the focused section shows as focused", () => {
    const search = searchOverlayViewState(typing("fallback"), 78, NOW);
    expect(search.input?.focused).toBe(true);
    expect(search.chip?.focused).toBe(false);

    const chip = searchOverlayViewState(
        { ...typing("fallback"), focus: "filter" },
        78,
        NOW,
    );
    expect(chip.input?.focused).toBe(false);
    expect(chip.chip?.focused).toBe(true);
    expect(chip.footer).toContain("space filter");
});

test("the scope toggle widens past this workspace and says so", () => {
    const state = typing("fallback");
    const widened = handleSearchOverlayKey(state, { name: "w", ctrl: true });

    expect(widened.state?.scope).toBe("everywhere");
    expect(searchOverlayQuery(widened.state ?? state))
        .toEqual({ query: "fallback" });
    expect(searchOverlayHeader(widened.state ?? state))
        .toBe("Search · everywhere");

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
    const state: SearchOverlayState = {
        ...applySearchResults(
            typing("fallback"),
            { query: "fallback", workspace: "/work/one" },
            results(),
        ),
        focus: "results",
    };
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
    const state: SearchOverlayState = {
        ...applySearchResults(
            typing("fallback"),
            { query: "fallback", workspace: "/work/one" },
            results(),
        ),
        focus: "results",
    };

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

test("results from another scope are dropped even when the text matches", () => {
    let state = startSearchOverlay("/work/one", {
        scope: "conversation",
        sessionId: "current-session",
    });
    state = updateSearchOverlayText(state, "fallback").state ?? state;

    const stale = applySearchResults(
        state,
        { query: "fallback" },
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
    expect(searchOverlayFooter(42, "results")).toBe("↑↓ ^u^d enter tab ^w esc");
});

test("the hit marks where the query sits in the line", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    const line = searchOverlayLines(state, { width: 78, now: NOW })
        .find((candidate) => candidate.text.includes("the fallback ladder"));

    expect(line).toBeDefined();
    if (line === undefined) throw new Error("no hit line");
    expect(line.emphasis).toBeDefined();
    const run = line.emphasis!;
    expect(line.text.slice(run.start, run.start + run.length))
        .toBe("fallback");
});

test("a snippet cut before the match marks nothing", () => {
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
                    kind: "agent_message",
                    // The host cut its snippet around a different occurrence,
                    // so the query is not on the line the reader sees.
                    snippet: "the degrade path stays inside the family",
                    entry_id: "entry-1",
                }],
            }],
        },
    );
    const line = searchOverlayLines(state, { width: 78, now: NOW })
        .find((candidate) => candidate.text.includes("degrade path"));

    expect(line).toBeDefined();
    expect(line?.emphasis).toBeUndefined();
});

test("the match is found whatever case the transcript wrote it in", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        {
            truncated: false,
            results: [{
                session_id: "caps",
                session_path: "/sessions/caps.jsonl",
                title: "caps",
                workspace: "/work/one",
                updated_at: "2026-08-09T10:00:00.000Z",
                hits: [{
                    kind: "agent_message",
                    snippet: "the Fallback ladder degrades in place",
                    entry_id: "entry-1",
                }],
            }],
        },
    );
    const line = searchOverlayLines(state, { width: 78, now: NOW })
        .find((candidate) => candidate.text.includes("Fallback"));

    expect(line).toBeDefined();
    if (line === undefined) throw new Error("no hit line");
    expect(line.text.slice(
        line.emphasis!.start,
        line.emphasis!.start + line.emphasis!.length,
    )).toBe("Fallback");
});

/** Typing into a pane opened from inside a conversation. */
function typingInside(query: string): SearchOverlayState {
    const state = startSearchOverlay("/work/one", {
        sessionId: "relay-gui",
        scope: "conversation",
    });
    return updateSearchOverlayText(state, query).state ?? state;
}

test("a search opened inside a conversation asks about that conversation", () => {
    const state = typingInside("fallback");

    // One session is narrower than any workspace it sits in, so the id is the
    // whole question and the directory adds nothing to it.
    expect(searchOverlayQuery(state)).toEqual({
        query: "fallback",
        session_id: "relay-gui",
    });
    expect(searchOverlayHeader(state)).toBe("Search · this conversation");
});

test("widening from a conversation reaches the workspace, then everywhere", () => {
    let state = typingInside("fallback");
    const seen: string[] = [state.scope];
    for (let press = 0; press < 3; press += 1) {
        state = handleSearchOverlayKey(state, { name: "w", ctrl: true })
            .state ?? state;
        seen.push(state.scope);
    }

    expect(seen).toEqual([
        "conversation",
        "workspace",
        "everywhere",
        "conversation",
    ]);
    // The session only rides along while the pane is asking about it.
    expect(searchOverlayQuery({ ...state, scope: "workspace" }))
        .toEqual({ query: "fallback", workspace: "/work/one" });
});

test("with no conversation behind it the pane starts on the workspace", () => {
    const state = typing("fallback");
    expect(state.scope).toBe("workspace");

    // `ctrl+w` has two stops here, not three: there is no conversation to
    // narrow to, so the cycle never offers one.
    const widened = handleSearchOverlayKey(state, { name: "w", ctrl: true })
        .state ?? state;
    const wrapped = handleSearchOverlayKey(widened, { name: "w", ctrl: true })
        .state ?? widened;
    expect([widened.scope, wrapped.scope]).toEqual(["everywhere", "workspace"]);
});

test("a conversation scope asked for without a conversation is ignored", () => {
    const state = startSearchOverlay("/work/one", { scope: "conversation" });
    expect(state.scope).toBe("workspace");
});

test("ctrl+d and ctrl+u move the cursor a page of hits at a time", () => {
    const state = {
        ...applySearchResults(
            typing("fallback"),
            { query: "fallback", workspace: "/work/one" },
            results(),
        ),
        selected: { sessionId: "relay-gui", hitIndex: 0 },
    };
    const all = searchSelections(state);
    expect(all.length).toBeLessThan(SEARCH_PAGE);

    // A page longer than the list lands on its last hit rather than nothing.
    const down = handleSearchOverlayKey(state, { name: "d", ctrl: true });
    expect(down.handled).toBe(true);
    expect(down.state?.selected).toEqual(all[all.length - 1]!);

    // And another press stays there: the list clamps rather than wrapping.
    const again = handleSearchOverlayKey(down.state!, { name: "d", ctrl: true });
    expect(again.state?.selected).toEqual(all[all.length - 1]!);

    const up = handleSearchOverlayKey(down.state!, { name: "u", ctrl: true });
    expect(up.state?.selected).toEqual(all[0]!);
});

test("paging asks for nothing and leaves the filter and scope alone", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );

    const paged = handleSearchOverlayKey(state, { name: "d", ctrl: true });
    expect(paged.action).toBeUndefined();
    expect(paged.state?.query).toBe("fallback");
    expect(paged.state?.filter).toBe(state.filter);
    expect(paged.state?.scope).toBe(state.scope);
});

test("a chord the pane does not claim is passed through untouched", () => {
    const state = typing("fallback");

    // The escape hatch is never swallowed, and the chord's letter is never
    // typed into the query either.
    const interrupt = handleSearchOverlayKey(state, { name: "c", ctrl: true });
    expect(interrupt.handled).toBe(false);
    expect(interrupt.state?.query ?? state.query).toBe("fallback");
});

test("a capital is typed, not treated as a chord", () => {
    // Shift arrives on every capital letter, so a pane that passes shift
    // through cannot be typed a name, a path, or a sentence that starts one.
    const state = updateSearchOverlayText(typing("fall"), "fallB");
    expect(state.handled).toBe(true);
    expect(state.state?.query).toBe("fallB");

    // Shifted keys that are not characters still belong to whoever owns them.
    const shiftTab = handleSearchOverlayKey(typing("fall"), {
        name: "tab",
        shift: true,
        sequence: "[Z",
    });
    expect(shiftTab.state?.query ?? "fall").toBe("fall");
});

test("the query is drawn in the card's input box, not as a result row", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: "/work/one" },
        results(),
    );
    const view = searchOverlayViewState(state, 78, NOW);

    expect(view.input?.text).toContain("fallback");
    // The list is results only, so nothing in it depends on the query's row.
    for (const line of view.lines) {
        expect(line.text.startsWith("> ")).toBe(false);
    }
    // The text form still opens with the query: it is the whole pane written
    // out, and the box is a drawing of the same thing.
    expect(searchOverlayText(state, { width: 78, now: NOW }))
        .toStartWith("> fallback\n");
});
