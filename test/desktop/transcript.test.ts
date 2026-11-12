import { describe, expect, test } from "bun:test";

import { entriesToBlocks, beginOlder, initialWatch, reduceWatch, watchClosed } from "../../clients/ui/src/session/transcript.ts";
import { MAX_HISTORY_BLOCKS, type Block, type SessionWatch } from "../../clients/ui/src/session/model.ts";
import { historyPageRequest, parseSessionLine, type SessionMessage } from "../../clients/ui/src/session/wire.ts";
import { toolTitle } from "../../clients/ui/src/session/toolTitle.ts";

function line(value: unknown): SessionMessage {
    const message = parseSessionLine(JSON.stringify(value));
    if (message === undefined) throw new Error("test line did not parse");
    return message;
}

function blocksOf(entries: readonly unknown[]): Block[] {
    const message = line({ type: "history", entries });
    if (message.type !== "history") throw new Error("expected a history message");
    return entriesToBlocks(message.entries);
}

function watchWithHistory(entries: readonly unknown[], page?: unknown): SessionWatch {
    const attached = reduceWatch(initialWatch("a1"), line({ type: "attached" }));
    return reduceWatch(attached, line({ type: "history", entries, page, status: "idle" }));
}

describe("parsing the watch connection", () => {
    test("junk, unknown types and unreadable fields come back undefined", () => {
        expect(parseSessionLine("not json")).toBeUndefined();
        expect(parseSessionLine("[]")).toBeUndefined();
        expect(parseSessionLine('{"seq":1}')).toBeUndefined();
        expect(parseSessionLine('{"type":"mystery","seq":2}')).toBeUndefined();
        expect(parseSessionLine('{"type":"background_agents","running":0,"children":[],"has_parent":false}')).toBeUndefined();
        expect(parseSessionLine('{"type":"status","state":"sleeping","seq":3}')).toBeUndefined();
        expect(parseSessionLine('{"type":"assistant_delta","seq":4}')).toBeUndefined();
        expect(parseSessionLine('{"type":"history","seq":5}')).toBeUndefined();
    });

    test("a readable update keeps only the fields the view uses", () => {
        expect(parseSessionLine('{"type":"user_prompt","content":"hi","seq":5}'))
            .toEqual({ type: "user_prompt", content: "hi" });
    });

    test("an entry of a kind the view does not show keeps its place in the list", () => {
        expect(line({ type: "history", entries: [{ kind: "empty" }, { kind: "user", id: "u1", text: "hi" }], status: "working" }))
            .toEqual({
                type: "history",
                entries: [{ kind: "other" }, { kind: "user", id: "u1", text: "hi" }],
                status: "working",
            });
    });

    test("a history page request is one JSON line", () => {
        expect(historyPageRequest("r1", "abc")).toBe('{"type":"history_page","request_id":"r1","before":"abc"}\n');
    });
});

describe("tool titles", () => {
    test("the main argument follows the tool name", () => {
        expect(toolTitle("bash", { command: "git status" })).toBe("bash git status");
        expect(toolTitle("grep", { pattern: "needle" })).toBe("grep needle");
        expect(toolTitle("web", { url: "https://example.test" })).toBe("web https://example.test");
    });

    test("a command is collapsed to one line", () => {
        expect(toolTitle("bash", { command: "npm run\n   build" })).toBe("bash npm run build");
    });

    test("a long command is cut at 96 characters", () => {
        expect(toolTitle("bash", { command: "x".repeat(120) })).toBe(`bash ${"x".repeat(96)}...`);
    });

    test("a path shows only its last segment", () => {
        expect(toolTitle("read", { path: "/w/src/config.ts" })).toBe("read config.ts");
        expect(toolTitle("edit", { file_path: "src/lib/" })).toBe("edit lib");
    });

    test("the first argument in the list wins, and non-strings are skipped", () => {
        expect(toolTitle("bash", { path: "a/b.ts", command: "ls" })).toBe("bash ls");
        expect(toolTitle("grep", { command: 5, query: "needle" })).toBe("grep needle");
    });

    test("with no such argument the title is the tool name", () => {
        expect(toolTitle("list", { limit: 3 })).toBe("list");
    });
});

describe("history entries to blocks", () => {
    test("consecutive tool entries and their results join one group", () => {
        const blocks = blocksOf([
            { kind: "user", id: "u1", text: "list files", recordedAt: 100 },
            { kind: "reasoning", id: "r0", text: "   " },
            { kind: "tool", id: "t1", tool: "bash", args: { command: "ls\n -la" } },
            { kind: "tool", id: "t2", tool: "read", args: { path: "/w/notes/a.md" } },
            { kind: "tool_result", id: "x1", tool: "bash", output: "a b", isError: false },
            { kind: "tool_result", id: "x2", tool: "read", output: "missing", isError: true },
            { kind: "tool", id: "t3", tool: "bash", args: { command: "pwd" } },
            { kind: "assistant", id: "a1", text: "Done." },
            { kind: "error", id: "e1", outcome: "aborted" },
            { kind: "harness", id: "h9", text: "Context trimmed", tone: "soft" },
            { kind: "harness", text: "Hook blocked", tone: "error" },
            { kind: "empty" },
        ]);
        expect(blocks).toEqual([
            { kind: "user", key: "u1", text: "list files", at: 100 },
            {
                kind: "tools",
                key: "t1",
                active: false,
                calls: [
                    { tool: "bash", title: "bash ls -la", args: { command: "ls\n -la" }, state: "done", output: "a b" },
                    { tool: "read", title: "read a.md", args: { path: "/w/notes/a.md" }, state: "failed", output: "missing" },
                    { tool: "bash", title: "bash pwd", args: { command: "pwd" }, state: "done" },
                ],
            },
            { kind: "text", key: "a1", text: "Done." },
            { kind: "notice", key: "e1", tone: "error", text: "aborted" },
            { kind: "notice", key: "h9", tone: "info", text: "Context trimmed" },
            { kind: "notice", key: "h10", tone: "error", text: "Hook blocked" },
        ]);
    });

    test("a text entry closes the group, so a later call starts a new one", () => {
        const blocks = blocksOf([
            { kind: "tool", id: "t1", tool: "bash", args: { command: "a" } },
            { kind: "assistant", id: "a1", text: "then" },
            { kind: "tool", id: "t2", tool: "bash", args: { command: "b" } },
        ]);
        expect(blocks.map((block) => block.kind)).toEqual(["tools", "text", "tools"]);
    });

    test("results pair with calls in order", () => {
        const blocks = blocksOf([
            { kind: "tool", id: "t1", tool: "bash", args: { command: "one" } },
            { kind: "tool", id: "t2", tool: "bash", args: { command: "two" } },
            { kind: "tool_result", tool: "bash", output: "first", isError: false },
            { kind: "tool_result", tool: "bash", output: "second", isError: false },
        ]);
        const [group] = blocks;
        expect(group?.kind === "tools" && group.calls.map((call) => call.output)).toEqual(["first", "second"]);
    });

    test("an error with no detail names its outcome, and a missing id falls back to the index", () => {
        const blocks = blocksOf([
            { kind: "user", text: "first" },
            { kind: "error", outcome: "error" },
        ]);
        expect(blocks).toEqual([
            { kind: "user", key: "h0", text: "first" },
            { kind: "notice", key: "h1", tone: "error", text: "error" },
        ]);
    });
});

describe("history and pages", () => {
    const users = (from: number, to: number): unknown[] =>
        Array.from({ length: to - from }, (_, offset) => ({ kind: "user", id: `u${from + offset}`, text: `m${from + offset}` }));

    test("a history replaces live blocks and keeps the newest blocks up to the cap", () => {
        const state = watchWithHistory(users(0, MAX_HISTORY_BLOCKS + 5), { hasMore: true, olderBefore: "u5" });
        expect(state.history.length).toBe(MAX_HISTORY_BLOCKS);
        expect(state.history[0]?.key).toBe("u5");
        expect(state.history.at(-1)?.key).toBe(`u${MAX_HISTORY_BLOCKS + 4}`);
        expect(state.live).toEqual([]);
        expect(state.hasOlder).toBe(true);
        expect(state.olderBefore).toBe("u5");
    });

    test("a page that pushes history past the cap keeps the cap and reports older history", () => {
        const full = watchWithHistory(users(5, MAX_HISTORY_BLOCKS + 5), { hasMore: true, olderBefore: "u5" });
        const loading = beginOlder(full);
        const page = reduceWatch(loading, line({
            type: "history_page",
            request_id: "r1",
            before: "u5",
            entries: [{ kind: "user", id: "p1", text: "older" }, { kind: "user", id: "p2", text: "older too" }],
            page: { pageVersion: 1, hasMore: true, olderBefore: "p1" },
        }));
        expect(page.history.length).toBe(MAX_HISTORY_BLOCKS);
        expect(page.hasOlder).toBe(true);
        expect(page.olderBefore).toBe("p1");
        expect(page.loadingOlder).toBe(false);
    });

    test("a page under the cap keeps everything and reports its own cursor", () => {
        const state = watchWithHistory([{ kind: "user", id: "u1", text: "m1" }], { hasMore: true, olderBefore: "u1" });
        const page = reduceWatch(beginOlder(state), line({
            type: "history_page",
            request_id: "r1",
            before: "u1",
            entries: [{ kind: "user", id: "u0", text: "m0" }],
            page: { pageVersion: 1, hasMore: false },
        }));
        expect(page.history.map((block) => block.key)).toEqual(["u0", "u1"]);
        expect(page.hasOlder).toBe(false);
        expect(page.olderBefore).toBeUndefined();
    });

    test("beginOlder only starts a load when there is older history and none is in flight", () => {
        const none = watchWithHistory([], undefined);
        expect(beginOlder(none)).toBe(none);
        const some = watchWithHistory(users(0, 2), { hasMore: true, olderBefore: "u0" });
        const loading = beginOlder(some);
        expect(loading.loadingOlder).toBe(true);
        expect(beginOlder(loading)).toBe(loading);
    });

    test("a failed page ends the load without changing the history", () => {
        const state = beginOlder(watchWithHistory(users(0, 2), { hasMore: true, olderBefore: "u0" }));
        const failed = reduceWatch(state, line({ type: "history_page_failed", request_id: "r1", reason: "busy" }));
        expect(failed.loadingOlder).toBe(false);
        expect(failed.history).toBe(state.history);
    });
});

describe("live updates", () => {
    test("prompt, thinking, tool calls, prose and the end of the turn fold into blocks", () => {
        let state = watchWithHistory([]);
        const steps: unknown[] = [
            { type: "user_prompt", content: "list and read" },
            { type: "assistant_thinking", text: "Let me " },
            { type: "assistant_thinking", text: "look." },
            { type: "tool_started", tool: "read", args: { path: "/w/config.ts" } },
            { type: "tool_started", tool: "bash", args: { command: "ls" } },
            { type: "tool_finished", tool: "read", output: "ok", isError: false },
            { type: "tool_finished", tool: "bash", output: "a.ts", isError: false },
            { type: "assistant_delta", text: "Found " },
            { type: "assistant_delta", text: "it" },
        ];
        for (const step of steps) state = reduceWatch(state, line(step));
        expect(state.status).toBe("working");
        expect(state.live[0]).toEqual({ kind: "user", key: "l0", text: "list and read" });

        state = reduceWatch(state, line({ type: "turn_finished" }));
        expect(state.status).toBe("idle");
        expect(state.live).toEqual([
            { kind: "user", key: "l0", text: "list and read" },
            { kind: "thought", key: "l1", text: "Let me look.", live: false },
            {
                kind: "tools",
                key: "l2",
                active: false,
                calls: [
                    { tool: "read", title: "read config.ts", args: { path: "/w/config.ts" }, state: "done", output: "ok" },
                    { tool: "bash", title: "bash ls", args: { command: "ls" }, state: "done", output: "a.ts" },
                ],
            },
            { kind: "text", key: "l3", text: "Found it" },
        ]);
    });

    test("an error turn adds an error notice, and an aborted one adds Stopped", () => {
        let state = watchWithHistory([]);
        state = reduceWatch(state, line({ type: "tool_started", tool: "bash", args: { command: "sleep 9" } }));
        state = reduceWatch(state, line({ type: "turn_finished", outcome: "error", error: "Provider timed out." }));
        expect(state.live.at(-1)).toEqual({ kind: "notice", key: "l1", tone: "error", text: "Provider timed out." });
        expect(state.live[0]).toEqual({
            kind: "tools",
            key: "l0",
            active: false,
            calls: [{ tool: "bash", title: "bash sleep 9", args: { command: "sleep 9" }, state: "failed" }],
        });

        state = reduceWatch(state, line({ type: "turn_finished", outcome: "aborted" }));
        expect(state.live.at(-1)).toEqual({ kind: "notice", key: "l2", tone: "info", text: "Stopped." });
    });

    test("an agent failure adds an error notice and returns to idle", () => {
        let state = reduceWatch(watchWithHistory([]), line({ type: "user_prompt", content: "go" }));
        state = reduceWatch(state, line({ type: "agent_failed", detail: "The host lost the session." }));
        expect(state.status).toBe("idle");
        expect(state.live.at(-1)).toEqual({ kind: "notice", key: "l1", tone: "error", text: "The host lost the session." });
    });

    test("status and session title update their own fields", () => {
        let state = reduceWatch(watchWithHistory([]), line({ type: "status", state: "waiting" }));
        expect(state.status).toBe("waiting");
        state = reduceWatch(state, line({ type: "session_title", title: "Refactor" }));
        expect(state.title).toBe("Refactor");
    });
});

describe("watch phases", () => {
    test("a failed attach names the reason and a later close keeps the failure", () => {
        const failed = reduceWatch(initialWatch("a1"), line({ type: "attach_failed", agent_id: "a1", reason: "not_found" }));
        expect(failed.phase).toBe("failed");
        expect(failed.error).toBe("This session no longer exists.");
        expect(watchClosed(failed, "Connection lost.")).toBe(failed);
    });

    test("a closed watch keeps its reason", () => {
        const closed = watchClosed(reduceWatch(initialWatch("a1"), line({ type: "attached" })), "Connection lost.");
        expect(closed.phase).toBe("closed");
        expect(closed.error).toBe("Connection lost.");
    });
});
