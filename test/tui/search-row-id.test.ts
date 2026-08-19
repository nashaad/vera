import { expect, test } from "bun:test";

import {
    applySearchResults,
    handleSearchOverlayKey,
    searchOverlayLines,
    searchRowId,
    searchSelectionOf,
    startSearchOverlay,
    type SearchOverlayState,
} from "../../clients/tui/search-overlay.ts";
import type { SessionSearchResults } from "../../src/store/session-search.ts";

/**
 * A pointer can carry one string, so a hit's identity is packed into one and
 * read back. Everything a mouse can do depends on that round trip holding.
 */

const NOW = new Date("2026-08-14T12:00:00.000Z");
const WORKSPACE = "/work/one";

function typing(query: string): SearchOverlayState {
    let state = startSearchOverlay(WORKSPACE);
    for (const character of query) {
        state = handleSearchOverlayKey(state, { name: character }).state ?? state;
    }
    return state;
}

const RESULTS: SessionSearchResults = {
    truncated: false,
    results: [{
        session_id: "relay-gui",
        session_path: "/sessions/relay-gui.jsonl",
        title: "relay-gui",
        workspace: WORKSPACE,
        updated_at: "2026-08-14T10:00:00.000Z",
        hits: [
            { kind: "user_message", snippet: "one", entry_id: "e1" },
            { kind: "tool_command", snippet: "two", entry_id: "e2" },
        ],
    }],
};

test("a hit's row id survives a round trip", () => {
    for (const selection of [
        { sessionId: "relay-gui", hitIndex: 0 },
        { sessionId: "relay-gui", hitIndex: 2 },
        // A session named with spaces or punctuation still comes back as
        // itself: the split is taken from the end, not the first match.
        { sessionId: "a b:c/d", hitIndex: 1 },
    ]) {
        expect(searchSelectionOf(searchRowId(selection))).toEqual(selection);
    }
});

test("a row id that is not one is refused rather than guessed at", () => {
    expect(searchSelectionOf("no separator")).toBeUndefined();
    expect(searchSelectionOf(searchRowId({ sessionId: "s", hitIndex: 0 })
        .replace("0", "notanumber"))).toBeUndefined();
    expect(searchSelectionOf(searchRowId({ sessionId: "s", hitIndex: 0 })
        .replace("0", "-1"))).toBeUndefined();
});

test("only hits carry a row id, so a click cannot land on a heading", () => {
    const state = applySearchResults(
        typing("fallback"),
        { query: "fallback", workspace: WORKSPACE },
        RESULTS,
    );

    for (const line of searchOverlayLines(state, { width: 78, now: NOW })) {
        expect(line.row_id === undefined, `${line.kind}: ${line.text}`)
            .toBe(line.kind !== "hit");
    }
});
