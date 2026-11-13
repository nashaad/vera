import { describe, expect, test } from "bun:test";

import {
    browse,
    currentEntry,
    displayAddress,
    HISTORY_LIMIT,
    pageAt,
    resolveAddress,
    START,
    step,
} from "../../clients/ui/src/browser/address.ts";
import type { AnnexPage } from "../../clients/ui/src/protocol/bridge.ts";

const BASE = "http://127.0.0.1:8372/";
const PAGES: readonly AnnexPage[] = [
    { label: "Usage", path: "/usage" },
    { label: "Runs", path: "/runs" },
    { label: "Ledger", path: "/x/budget/ledger", extensionId: "vera.budget" },
];

describe("the browser history", () => {
    test("@core back and forward move through what was opened, and opening drops what was ahead", () => {
        let history = browse(browse(START, "/usage"), "/runs");
        expect(history.entries).toEqual(["", "/usage", "/runs"]);
        history = step(step(history, -1), -1);
        expect(currentEntry(history)).toBe("");
        expect(step(history, -1)).toBe(history);
        history = step(history, 1);
        expect(currentEntry(history)).toBe("/usage");
        history = browse(history, "/x/budget/ledger");
        expect(history.entries).toEqual(["", "/usage", "/x/budget/ledger"]);
        expect(step(history, 1)).toBe(history);
    });

    test("opening the page already shown adds nothing, and the list keeps its newest entries", () => {
        const once = browse(START, "/usage");
        expect(browse(once, "/usage")).toBe(once);
        let history = START;
        for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) history = browse(history, `/p${index}`);
        expect(history.entries.length).toBe(HISTORY_LIMIT);
        expect(history.at).toBe(HISTORY_LIMIT - 1);
        expect(currentEntry(history)).toBe(`/p${HISTORY_LIMIT + 9}`);
    });
});

describe("the address bar", () => {
    test("@core an address on the annex, a path or a page's name opens that page", () => {
        expect(resolveAddress("127.0.0.1:8372/usage", BASE, PAGES)).toBe("/usage");
        expect(resolveAddress("http://localhost:8372/runs", BASE, PAGES)).toBe("/runs");
        expect(resolveAddress("vera.localhost:8372", BASE, PAGES)).toBe("/");
        expect(resolveAddress("/x/budget/ledger", BASE, PAGES)).toBe("/x/budget/ledger");
        expect(resolveAddress("  ledger ", BASE, PAGES)).toBe("/x/budget/ledger");
        expect(resolveAddress("", BASE, PAGES)).toBe("");
    });

    test("@core anything else is kept as typed and is not an annex path", () => {
        expect(resolveAddress("example.com/usage", BASE, PAGES)).toBe("example.com/usage");
        expect(resolveAddress("127.0.0.1:9999/usage", BASE, PAGES)).toBe("127.0.0.1:9999/usage");
        expect(resolveAddress("usage", undefined, [])).toBe("usage");
    });

    test("the bar shows the annex host before a path and leaves other text alone", () => {
        expect(displayAddress("/usage", BASE)).toBe("127.0.0.1:8372/usage");
        expect(displayAddress("/usage", undefined)).toBe("/usage");
        expect(displayAddress("", BASE)).toBe("");
        expect(displayAddress("example.com", BASE)).toBe("example.com");
    });

    test("@core a path belongs to a listed page only when it names that page", () => {
        expect(pageAt("/usage", PAGES)?.label).toBe("Usage");
        expect(pageAt("/usage/?days=7#top", PAGES)?.label).toBe("Usage");
        expect(pageAt("/usage/more", PAGES)).toBeUndefined();
        expect(pageAt("/", PAGES)).toBeUndefined();
        expect(pageAt("/\\example.com", PAGES)).toBeUndefined();
    });
});
