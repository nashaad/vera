import { expect, test } from "bun:test";

import { parseResults, searchArgument } from "../../clients/desktop/src/search-requests.ts";
import { inScope, markSnippet, mergeMatches, titleMatches, workspaceChoices } from "../../clients/ui/src/pages/search.ts";
import type { SessionSearchMatch } from "../../clients/ui/src/protocol/bridge.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

function row(id: string, name: string, workspace: string, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name, workspace, status: "idle", live: false, ...extra };
}

const everything = { workspace: undefined, agentId: undefined };

test("@core the search argument trims the query and drops empty, over-long and relative requests", () => {
    expect(searchArgument({ query: "  plan  ", workspace: "/p/crow", agentId: "a1" })).toEqual({
        query: "plan",
        workspace: "/p/crow",
        agentId: "a1",
    });
    expect(searchArgument({ query: "plan" })).toEqual({ query: "plan" });
    expect(searchArgument({ query: "   " })).toBeUndefined();
    expect(searchArgument({ query: "x".repeat(201) })).toBeUndefined();
    expect(searchArgument({ query: "x".repeat(200) })).toEqual({ query: "x".repeat(200) });
    expect(searchArgument({ query: "plan", workspace: "crow/vera" })).toEqual({ query: "plan" });
    expect(searchArgument({ query: "plan", agentId: "" })).toEqual({ query: "plan" });
    expect(searchArgument("plan")).toBeUndefined();
});

test("@core a search reply maps session_id to agentId and keeps the host order", () => {
    const parsed = parseResults({
        truncated: true,
        results: [
            {
                session_id: "s1",
                title: "Plan",
                workspace: "/p/crow",
                updated_at: "2026-11-01T10:00:00Z",
                hits: [{ kind: "user_message", snippet: "the plan" }],
            },
            { session_id: "s2", title: "Other", workspace: "/p/parrot", updated_at: "not a time", hits: [] },
        ],
    });
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok !== true) return;
    expect(parsed.truncated).toBe(true);
    expect(parsed.matches.map((match) => match.agentId)).toEqual(["s1", "s2"]);
    expect(parsed.matches[0]?.hits).toEqual([{ kind: "user_message", snippet: "the plan" }]);
    expect(Number.isNaN(parsed.matches[1]?.updatedAt)).toBe(true);
});

test("@core a search reply with an unknown hit kind is refused", () => {
    expect(parseResults({
        truncated: false,
        results: [{
            session_id: "s1",
            title: "Plan",
            workspace: "/p",
            updated_at: "2026-11-01T10:00:00Z",
            hits: [{ kind: "system_prompt", snippet: "x" }],
        }],
    })).toBeUndefined();
});

test("@core a search reply with more than 20 results is refused", () => {
    const result = (index: number) => ({
        session_id: `s${index}`,
        title: "t",
        workspace: "/p",
        updated_at: "2026-11-01T10:00:00Z",
        hits: [],
    });
    expect(parseResults({ truncated: false, results: Array.from({ length: 20 }, (_, i) => result(i)) })?.ok).toBe(true);
    expect(parseResults({ truncated: false, results: Array.from({ length: 21 }, (_, i) => result(i)) })).toBeUndefined();
});

test("a snippet marks the query case-insensitively and leaves a miss unmarked", () => {
    expect(markSnippet("We wrote the Plan down", "plan")).toEqual([
        { text: "We wrote the ", marked: false },
        { text: "Plan", marked: true },
        { text: " down", marked: false },
    ]);
    expect(markSnippet("the plan", "plan")).toEqual([{ text: "the ", marked: false }, { text: "plan", marked: true }]);
    expect(markSnippet("nothing here", "plan")).toEqual([{ text: "nothing here", marked: false }]);
    expect(markSnippet("a.b c", "a.b")).toEqual([{ text: "a.b", marked: true }, { text: " c", marked: false }]);
});

test("title matches honour the scope and skip rows without the query", () => {
    const rows = [
        row("a", "Fix the Build", "/p/crow"),
        row("b", "Build notes", "/p/parrot"),
        row("c", "Unrelated", "/p/crow"),
    ];
    expect(titleMatches(rows, "build", everything).map((r) => r.id)).toEqual(["a", "b"]);
    expect(titleMatches(rows, "build", { workspace: "/p/crow", agentId: undefined }).map((r) => r.id)).toEqual(["a"]);
    expect(titleMatches(rows, "build", { workspace: undefined, agentId: "b" }).map((r) => r.id)).toEqual(["b"]);
    expect(titleMatches(rows, "  ", everything)).toEqual([]);
});

test("host matches come first and a session already matched is not repeated", () => {
    const host: SessionSearchMatch[] = [
        { agentId: "b", title: "Host title", workspace: "/p/parrot", updatedAt: 1000, hits: [{ kind: "agent_message", snippet: "x" }] },
        { agentId: "a", title: "Also host", workspace: "/p/crow", updatedAt: Number.NaN, hits: [] },
    ];
    const merged = mergeMatches(host, [row("a", "Fix the Build", "/p/crow", { updatedAt: 5 }), row("c", "Build", "/p/crow", { updatedAt: 7 })]);
    expect(merged.map((item) => [item.agentId, item.title, item.updatedAt, item.hits.length])).toEqual([
        ["b", "Host title", 1000, 1],
        ["a", "Also host", undefined, 0],
        ["c", "Build", 7, 0],
    ]);
});

test("workspace choices are distinct, non-empty and labelled by folder", () => {
    const choices = workspaceChoices([
        row("a", "a", "/Users/crow/vera"),
        row("b", "b", ""),
        row("c", "c", "/Users/crow/vera"),
        row("d", "d", "/Users/crow/parrot/"),
    ]);
    expect(choices).toEqual([
        { workspace: "/Users/crow/vera", label: "vera" },
        { workspace: "/Users/crow/parrot/", label: "parrot" },
    ]);
});

test("the workspace filter and the conversation filter combine", () => {
    expect(inScope("a", "/p", everything)).toBe(true);
    expect(inScope("a", "/p", { workspace: "/q", agentId: undefined })).toBe(false);
    expect(inScope("a", "/p", { workspace: undefined, agentId: "b" })).toBe(false);
    expect(inScope("a", "/p", { workspace: "/p", agentId: "a" })).toBe(true);
});
