import { describe, expect, test } from "bun:test";

import { entriesToBlocks, beginOlder, initialWatch, reduceWatch, watchClosed, watchOpening } from "../../clients/ui/src/session/transcript.ts";
import { MAX_HISTORY_BLOCKS, type Block, type SessionWatch } from "../../clients/ui/src/session/model.ts";
import {
    abortCommand,
    historyPageRequest,
    parseSessionLine,
    promptCommand,
    releaseQueuedCommand,
    withdrawQueuedCommand,
    type SessionMessage,
} from "../../clients/ui/src/session/wire.ts";
import { toolTitle } from "../../clients/ui/src/session/toolTitle.ts";
import { keepTurns, toTurns } from "../../clients/ui/src/session/turns.ts";

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
        expect(parseSessionLine('{"type":"background_agents","children":[],"has_parent":false}')).toBeUndefined();
        expect(parseSessionLine('{"type":"status","state":"sleeping","seq":3}')).toBeUndefined();
        expect(parseSessionLine('{"type":"assistant_delta","seq":4}')).toBeUndefined();
        expect(parseSessionLine('{"type":"history","seq":5}')).toBeUndefined();
    });

    test("a readable update keeps only the fields the view uses", () => {
        expect(parseSessionLine('{"type":"user_prompt","content":"hi","seq":5}'))
            .toEqual({ type: "user_prompt", content: "hi" });
    });

    test("an entry of a kind the view does not show keeps its place in the list", () => {
        expect(line({ type: "history", entries: [{ kind: "hook_context", phase: "pre_turn" }, { kind: "user", id: "u1", text: "hi" }], status: "working" }))
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
            { kind: "user", key: "u1", entryId: "u1", text: "list files", at: 100 },
            {
                kind: "tools",
                key: "t1",
                active: false,
                calls: [
                    { tool: "bash", entryId: "t1", title: "bash ls -la", args: { command: "ls\n -la" }, state: "done", output: "a b", isError: false },
                    { tool: "read", entryId: "t2", title: "read a.md", args: { path: "/w/notes/a.md" }, state: "failed", output: "missing", isError: true },
                    { tool: "bash", entryId: "t3", title: "bash pwd", args: { command: "pwd" }, state: "done" },
                ],
            },
            { kind: "text", key: "a1", entryId: "a1", text: "Done." },
            { kind: "notice", key: "e1", tone: "info", text: "Stopped." },
            { kind: "notice", key: "h9", tone: "info", text: "Context trimmed" },
            { kind: "notice", key: "h10", tone: "error", text: "Hook blocked" },
            { kind: "notice", key: "h11", tone: "info", text: "This turn ended with nothing to show." },
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

    test("an error with no detail says the turn failed, and a missing id falls back to the index", () => {
        const blocks = blocksOf([
            { kind: "user", text: "first" },
            { kind: "error", outcome: "error" },
        ]);
        expect(blocks).toEqual([
            { kind: "user", key: "h0", text: "first" },
            { kind: "notice", key: "h1", tone: "error", text: "The turn failed." },
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
                    { tool: "read", title: "read config.ts", args: { path: "/w/config.ts" }, state: "done", output: "ok", isError: false },
                    { tool: "bash", title: "bash ls", args: { command: "ls" }, state: "done", output: "a.ts", isError: false },
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

describe("host stop causes", () => {
    test("error-shaped host loss uses its cause live and in history", () => {
        for (const [stopCause, text] of [
            ["host_stopped", "Host stopped"],
            ["host_stopped_unexpectedly", "Host stopped unexpectedly"],
        ]) {
            const live = reduceWatch(watchWithHistory([]), line({
                type: "turn_finished",
                outcome: "error",
                error: "The session process exited.",
                stopCause,
            }));
            expect(live.live.at(-1)).toMatchObject({ kind: "notice", text });
            const saved = watchWithHistory([{
                kind: "error",
                outcome: "error",
                detail: "The session process exited.",
                stopCause,
            }]);
            expect(saved.history.at(-1)).toMatchObject({ kind: "notice", text });
        }
    });

    test("live, saved and paged history preserve causes and ignore unknown values", () => {
        const live = reduceWatch(watchWithHistory([]), line({
            type: "turn_finished",
            outcome: "aborted",
            stopCause: "host_stopped",
        }));
        expect(live.live.at(-1)).toMatchObject({ kind: "notice", text: "Host stopped" });

        const unexpected = parseSessionLine(JSON.stringify({
            type: "turn_finished",
            outcome: "aborted",
            stopCause: "host_stopped_unexpectedly",
        }));
        expect(unexpected?.type).toBe("turn_finished");
        if (unexpected?.type !== "turn_finished") throw new Error("expected turn finish");
        expect(unexpected.stopCause).toBe("host_stopped_unexpectedly");

        const saved = watchWithHistory([
            { kind: "error", id: "e1", outcome: "aborted", stopCause: "host_stopped" },
            {
                kind: "harness",
                id: "h2",
                text: "Vera crashed before this turn finished",
                tone: "error",
                stopCause: "host_stopped_unexpectedly",
            },
            { kind: "error", id: "e3", outcome: "aborted", stopCause: "unknown" },
            { kind: "error", id: "e4", outcome: "aborted" },
        ]);
        expect(saved.history.map((block) => block.kind === "notice" ? block.text : "")).toEqual([
            "Host stopped",
            "Host stopped unexpectedly",
            "Stopped.",
            "Stopped.",
        ]);
        expect(saved.live).toEqual([]);

        const paged = reduceWatch(beginOlder(watchWithHistory([], {
            hasMore: true,
            olderBefore: "before",
        })), line({
            type: "history_page",
            request_id: "page-1",
            entries: [{
                kind: "harness",
                id: "h1",
                text: "old crash wording",
                tone: "error",
                stopCause: "host_stopped_unexpectedly",
            }],
            page: { hasMore: false },
        }));
        expect(paged.history).toEqual([{
            kind: "notice",
            key: "h1",
            tone: "error",
            text: "Host stopped unexpectedly",
        }]);
    });
});

describe("watch phases", () => {
    test("a failed attach names the reason and a later close keeps the failure", () => {
        const failed = reduceWatch(initialWatch("a1"), line({ type: "attach_failed", agent_id: "a1", reason: "not_found" }));
        expect(failed.phase).toBe("failed");
        expect(failed.error).toBe("This session no longer exists.");
        expect(watchClosed(failed, "Connection lost.")).toBe(failed);
    });

    test("@core a session is still opening until its history arrives", () => {
        const attaching = initialWatch("a1");
        const attached = reduceWatch(attaching, line({ type: "attached" }));
        const empty = reduceWatch(attached, line({ type: "history", entries: [] }));
        expect([watchOpening(attaching), watchOpening(attached), watchOpening(empty)]).toEqual([true, true, false]);
        expect(watchOpening(watchClosed(attached, "Connection lost."))).toBe(false);
    });

    test("a closed watch keeps its reason", () => {
        const closed = watchClosed(reduceWatch(initialWatch("a1"), line({ type: "attached" })), "Connection lost.");
        expect(closed.phase).toBe("closed");
        expect(closed.error).toBe("Connection lost.");
    });
});

describe("prompt queue", () => {
    test("history carries the queue and a queue update replaces it", () => {
        let watch = reduceWatch(initialWatch("a"), line({
            type: "history",
            entries: [],
            promptQueue: { prompts: [{ content: "next", state: "held" }], draining: false },
        }));
        expect(watch.queue).toEqual([{ content: "next", state: "held" }]);
        watch = reduceWatch(watch, line({
            type: "prompt_queue",
            seq: 3,
            queue: { prompts: [{ content: "next", state: "released" }, { content: "then" }], draining: true },
        }));
        expect(watch.queue).toEqual([{ content: "next", state: "released" }, { content: "then", state: "held" }]);
    });

    test("a history without a queue clears it", () => {
        const queued = reduceWatch(initialWatch("a"), line({
            type: "prompt_queue",
            queue: { prompts: [{ content: "x", state: "held" }], draining: false },
        }));
        expect(reduceWatch(queued, line({ type: "history", entries: [] })).queue).toEqual([]);
    });

    test("a withdrawn prompt is kept for the composer", () => {
        const watch = reduceWatch(initialWatch("a"), line({ type: "prompt_withdrawn", requestId: "w1", content: "redo", seq: 4 }));
        expect(watch.withdrawn).toEqual({ requestId: "w1", content: "redo" });
    });

    test("a rejected admission and a prompt rejection both mark the prompt refused", () => {
        expect(parseSessionLine(JSON.stringify({ type: "prompt_admission", requestId: "p1", content: "hi", status: "accepted", seq: 1 }))).toBeUndefined();
        const rejected = reduceWatch(initialWatch("a"), line({
            type: "prompt_admission", requestId: "p2", content: "hi", status: "rejected", reason: "No model is set.", seq: 2,
        }));
        expect(rejected.refused).toEqual({ requestId: "p2", content: "hi", reason: "No model is set." });
        const bare = reduceWatch(initialWatch("a"), line({ type: "prompt_rejected", reason: "Busy." }));
        expect(bare.refused).toEqual({ reason: "Busy." });
    });

    test("command lines are single JSON lines", () => {
        expect(JSON.parse(promptCommand("hi", "p1"))).toEqual({ type: "prompt", content: "hi", requestId: "p1" });
        expect(JSON.parse(abortCommand())).toEqual({ type: "abort" });
        expect(JSON.parse(releaseQueuedCommand("all"))).toEqual({ type: "release_queued_prompts", mode: "all" });
        expect(JSON.parse(withdrawQueuedCommand("w1"))).toEqual({ type: "withdraw_queued_prompt", requestId: "w1" });
        for (const text of [promptCommand("a\nb", "p"), abortCommand()]) {
            expect(text.endsWith("\n")).toBe(true);
            expect(text.slice(0, -1).includes("\n")).toBe(false);
        }
    });
});

describe("keeping turn renders", () => {
    const threeTurns = (): unknown[] => [
        { kind: "user", id: "u1", text: "first" },
        { kind: "assistant", id: "a1", text: "one" },
        { kind: "user", id: "u2", text: "second" },
        { kind: "assistant", id: "a2", text: "two" },
        { kind: "user", id: "u3", text: "third" },
        { kind: "assistant", id: "a3", text: "three" },
    ];

    test("the same blocks give back the same render objects", () => {
        const blocks = blocksOf(threeTurns());
        const first = keepTurns(new Map(), blocks);
        const second = keepTurns(first.byKey, blocks);
        expect(second.renders.length).toBe(3);
        expect(second.renders).toEqual(first.renders);
        second.renders.forEach((render, index) => expect(render === first.renders[index]).toBe(true));
    });

    test("after a live delta only the last turn gets a new render", () => {
        const before = watchWithHistory(threeTurns());
        const after = reduceWatch(before, line({ type: "assistant_delta", text: " more" }));
        const first = keepTurns(new Map(), before.history);
        const second = keepTurns(first.byKey, [...after.history, ...after.live]);
        expect(second.renders.length).toBe(3);
        expect(second.renders[0]).toBe(first.renders[0]);
        expect(second.renders[1]).toBe(first.renders[1]);
        expect(second.renders[2]).not.toBe(first.renders[2]);
        expect(second.byKey.get("u3")).toBe(second.renders[2]);
    });

    test("a turn that is no longer in blocks is not in the new byKey", () => {
        const blocks = blocksOf(threeTurns());
        const first = keepTurns(new Map(), blocks);
        const shorter = keepTurns(first.byKey, blocks.slice(0, 4));
        expect(shorter.renders.length).toBe(2);
        expect(shorter.byKey.has("u3")).toBe(false);
        expect(shorter.byKey.get("u1")).toBe(first.renders[0]);
    });
});

describe("reasoning progress", () => {
    const progress = (characters: number): unknown => ({ type: "assistant_thinking_progress", characters, seq: 9 });

    test("a progress update keeps its character count and nothing else", () => {
        expect(parseSessionLine(JSON.stringify(progress(120)))).toEqual({ type: "assistant_thinking_progress", characters: 120 });
        expect(parseSessionLine(JSON.stringify(progress(0)))).toEqual({ type: "assistant_thinking_progress", characters: 0 });
        for (const characters of [-1, 1.5, "12", null, Number.MAX_VALUE]) {
            expect(parseSessionLine(JSON.stringify({ type: "assistant_thinking_progress", characters }))).toBeUndefined();
        }
        expect(parseSessionLine('{"type":"assistant_thinking_progress","seq":4}')).toBeUndefined();
    });

    test("progress folds into one live thought that holds a count and no text", () => {
        let state = watchWithHistory([]);
        for (const step of [{ type: "user_prompt", content: "hi" }, progress(40), progress(25)]) state = reduceWatch(state, line(step));
        expect(state.live).toEqual([
            { kind: "user", key: "l0", text: "hi" },
            { kind: "thought", key: "l1", text: "", live: true, hiddenCharacters: 65 },
        ]);
        state = reduceWatch(state, line({ type: "assistant_delta", text: "Done" }));
        expect(state.live[1]).toEqual({ kind: "thought", key: "l1", text: "", live: false, hiddenCharacters: 65 });
    });

    test("progress clears a pending retry, as reasoning text does", () => {
        let state = watchWithHistory([]);
        state = reduceWatch(state, line({
            type: "model_activity",
            phase: "retrying",
            model: "crow-1",
            nextAttempt: 2,
            maxAttempts: 4,
            delayMs: 1000,
            retryAt: "1970-01-01T00:00:05.000Z",
            failure: { kind: "server", statusCode: 502 },
        }));
        expect(state.retry).toBeDefined();
        state = reduceWatch(state, line(progress(10)));
        expect(state.retry).toBeUndefined();
    });

    test("a turn counts reasoning characters whether or not the thoughts are drawn", () => {
        let state = watchWithHistory([]);
        for (const step of [
            { type: "user_prompt", content: "hi" },
            progress(100),
            { type: "tool_started", tool: "bash", args: { command: "ls" } },
            { type: "assistant_thinking", text: "twelve chars" },
            { type: "assistant_delta", text: "ok" },
        ]) state = reduceWatch(state, line(step));
        const blocks = [...state.history, ...state.live];
        const hidden = toTurns(blocks, { reasoning: false });
        const shown = toTurns(blocks, { reasoning: true });
        expect(hidden[0]?.thoughtCharacters).toBe(112);
        expect(shown[0]?.thoughtCharacters).toBe(112);
        expect(hidden[0]?.work.some((block) => block.kind === "thought")).toBe(false);
        expect(shown[0]?.work.filter((block) => block.kind === "thought")).toHaveLength(2);
    });

    test("a turn that gains only reasoning characters draws again", () => {
        let state = watchWithHistory([]);
        state = reduceWatch(state, line({ type: "user_prompt", content: "hi" }));
        state = reduceWatch(state, line(progress(10)));
        const options = { reasoning: false };
        const first = keepTurns(new Map(), [...state.history, ...state.live], options);
        state = reduceWatch(state, line(progress(10)));
        const second = keepTurns(first.byKey, [...state.history, ...state.live], options);
        expect(second.renders[0]).not.toBe(first.renders[0]);
        expect(second.renders[0]?.turn.thoughtCharacters).toBe(20);
        const third = keepTurns(second.byKey, [...state.history, ...state.live], options);
        expect(third.renders[0]).toBe(second.renders[0]);
    });

    test("history reasoning entries still count toward a finished turn", () => {
        const turns = toTurns(blocksOf([
            { kind: "user", id: "u1", text: "go" },
            { kind: "reasoning", id: "r1", text: "abcd efgh" },
            { kind: "assistant", id: "a1", text: "done" },
        ]), { reasoning: false });
        expect(turns).toHaveLength(1);
        expect(turns[0]?.thoughtCharacters).toBe(9);
        expect(turns[0]?.work).toEqual([]);
    });
});
