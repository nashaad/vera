import { expect, test } from "bun:test";

import {
    DEFAULT_SESSION_SORT,
    modelQueryMatches,
    nextSessionSort,
    pageSlice,
    modelListQuery,
    sessionMatchesModelFilter,
    sessionMatchesModelQuery,
    sortSessions,
} from "../../clients/web/sessions-table.ts";
import type { UsageSessionRow } from "../../src/host/usage-report.ts";

function row(overrides: Partial<UsageSessionRow>): UsageSessionRow {
    return {
        id: "a",
        title: "alpha",
        workspace: "/work/vera",
        workspaceLabel: "vera",
        kind: "interactive",
        calls: 10,
        own: 1,
        children: 0,
        combined: 1,
        costKind: "reported",
        updatedAt: "2026-08-30T00:00:00.000Z",
        models: [],
        ...overrides,
    };
}

test("default sort is combined cost descending, then recency", () => {
    const rows = [
        row({ id: "old-high", combined: 5, updatedAt: "2026-08-01T00:00:00.000Z" }),
        row({ id: "new-high", combined: 5, updatedAt: "2026-08-20T00:00:00.000Z" }),
        row({ id: "low", combined: 1, updatedAt: "2026-08-30T00:00:00.000Z" }),
    ];
    expect(sortSessions(rows, DEFAULT_SESSION_SORT).map((item) => item.id))
        .toEqual(["new-high", "old-high", "low"]);
});

test("clicking a new numeric column starts descending", () => {
    expect(nextSessionSort(DEFAULT_SESSION_SORT, "calls"))
        .toEqual({ key: "calls", dir: "desc" });
});

test("clicking a new text column starts ascending", () => {
    expect(nextSessionSort(DEFAULT_SESSION_SORT, "title"))
        .toEqual({ key: "title", dir: "asc" });
});

test("clicking the active column flips direction", () => {
    expect(nextSessionSort({ key: "title", dir: "asc" }, "title"))
        .toEqual({ key: "title", dir: "desc" });
});

test("kind sorts by the displayed chat/sub label", () => {
    const rows = [
        row({ id: "sub", kind: "subagent", title: "child" }),
        row({ id: "chat", kind: "interactive", title: "parent" }),
    ];
    expect(sortSessions(rows, { key: "kind", dir: "asc" }).map((item) => item.id))
        .toEqual(["chat", "sub"]);
});

test("pageSlice reports 1-based range and clamps the page", () => {
    const rows = Array.from({ length: 63 }, (_, index) => index);
    const first = pageSlice(rows, 0, 25);
    expect(first).toMatchObject({ page: 0, pages: 3, from: 1, to: 25, total: 63 });
    expect(first.rows).toHaveLength(25);
    const last = pageSlice(rows, 9, 25);
    expect(last).toMatchObject({ page: 2, from: 51, to: 63 });
    expect(last.rows).toHaveLength(13);
});

test("empty list is page 0 of 1 with a zero range", () => {
    expect(pageSlice([], 3, 25)).toEqual({
        page: 0,
        pages: 1,
        rows: [],
        from: 0,
        to: 0,
        total: 0,
    });
});

test("empty model query matches every id", () => {
    expect(modelQueryMatches("openrouter/x-ai/grok-4.6", "")).toBe(true);
    expect(modelQueryMatches("openrouter/x-ai/grok-4.6", "  ")).toBe(true);
});

test("model query matches a case-insensitive name substring", () => {
    expect(modelQueryMatches("openrouter/x-ai/grok-4.6", "GROK")).toBe(true);
    expect(modelQueryMatches("openrouter/openai/gpt-5.6-luna", "luna")).toBe(true);
    expect(modelQueryMatches("openrouter/x-ai/grok-4.6", "claude")).toBe(false);
});

test("a session matches if any of its models match the query", () => {
    expect(sessionMatchesModelQuery(
        ["openrouter/x-ai/grok-4.6", "ollama/smollm2:135m"],
        "luna",
    )).toBe(false);
    expect(sessionMatchesModelQuery(
        ["openrouter/x-ai/grok-4.6", "openrouter/openai/gpt-5.6-luna"],
        "luna",
    )).toBe(true);
    expect(sessionMatchesModelQuery([], "grok")).toBe(false);
    expect(sessionMatchesModelQuery(["openrouter/x-ai/grok-4.6"], "")).toBe(true);
});

test("a pin matches that exact route only", () => {
    const models = [
        "openrouter/x-ai/grok-4.6",
        "openrouter/openai/gpt-5.6-luna",
    ];
    expect(sessionMatchesModelFilter(models, "luna", "openrouter/x-ai/grok-4.6"))
        .toBe(true);
    expect(sessionMatchesModelFilter(
        ["openrouter/openai/gpt-5.6-luna"],
        "luna",
        "openrouter/x-ai/grok-4.6",
    )).toBe(false);
    expect(sessionMatchesModelFilter(models, "luna", "openrouter/anthropic/claude"))
        .toBe(false);
    expect(sessionMatchesModelFilter(models, "luna", undefined)).toBe(true);
});

test("reopening a pin shows the full list", () => {
    expect(modelListQuery("openrouter/x-ai/grok-4.6", "openrouter/x-ai/grok-4.6"))
        .toBe("");
    expect(modelListQuery("luna", "openrouter/openai/gpt-5.6-luna")).toBe("luna");
    expect(modelListQuery("luna", undefined)).toBe("luna");
});
