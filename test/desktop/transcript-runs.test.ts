import { describe, expect, test } from "bun:test";

import type { Block, ToolCall, ToolsBlock } from "../../clients/ui/src/session/model.ts";
import { askTarget, askTitle, callTarget, liveAction, rowVerb, shellCommand, toolSummary } from "../../clients/ui/src/session/toolTitle.ts";
import { keepTurns, toTurns } from "../../clients/ui/src/session/turns.ts";
import { estimateTokens, elapsedText } from "../../clients/ui/src/session/LiveStatus.tsx";

function call(tool: string, args: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
    return { tool, title: `${tool} x`, args, state: "done", ...extra };
}

function tools(key: string, calls: readonly ToolCall[]): ToolsBlock {
    return { kind: "tools", key, calls, active: false };
}

const written = (path: string): ToolCall => call("write", { path }, {
    presentation: { kind: "diff", diff: { path, patch: "+a", added: 1, removed: 0, scratch: false } },
});

describe("tool vocabulary", () => {
    test("a run reads as one past-tense line, in the order each kind first ran", () => {
        const calls = [
            call("bash", { command: "ls" }),
            call("read", { path: "/w/a.md" }),
            call("bash", { command: "pwd" }),
            call("bash", { command: "date" }),
            call("read", { path: "/w/b.md" }),
        ];
        expect(toolSummary(calls)).toBe("Ran 3 commands, read 2 files");
        expect(toolSummary([call("grep", { pattern: "crow" })])).toBe("Searched once");
        expect(toolSummary([call("mystery_tool", {})])).toBe("Used mystery_tool");
    });

    test("an approval is an action and a target", () => {
        expect(askTitle("write")).toBe("Create");
        expect(askTitle("bash")).toBe("Run");
        expect(askTitle("mystery_tool")).toBe("mystery_tool");
        expect(askTarget("write", { path: "/nest/index.html" })).toBe("/nest/index.html");
        expect(askTarget("bash", { command: "touch\n  /nest/egg" })).toBe("touch /nest/egg");
        const long = `echo ${"caw ".repeat(60)}`.trim();
        expect(askTarget("bash", { command: long })).toBe(long);
    });

    test("the status line names the running call and what it acts on", () => {
        expect(liveAction(call("read", { path: "/nest/crow/app.js" }, { state: "running" }))).toEqual({ label: "Reading", target: "app.js" });
        expect(liveAction(call("bash", { command: "bun test" }, { state: "running" }))).toEqual({ label: "Running", target: "bun test" });
        expect(liveAction(call("grep", { pattern: "caw", path: "/nest" }, { state: "running" })).target).toBe("caw");
    });

    test("rows use the past-tense verb and a path is cut to what tells it apart", () => {
        expect(rowVerb(call("edit", { path: "/a/x.ts" }))).toBe("Edited");
        const paths = ["/a/x.ts", "/b/x.ts"];
        expect(callTarget(call("edit", { path: "/a/x.ts" }), paths)).toBe("a/x.ts");
        expect(callTarget(call("edit", { path: "/a/x.ts" }))).toBe("x.ts");
    });

    test("a shell box keeps the command whole, line breaks included", () => {
        expect(shellCommand(call("bash", { command: "echo caw\necho caw" }))).toBe("echo caw\necho caw");
    });
});

describe("status line numbers", () => {
    test("streamed text counts one token per four characters, rounded up", () => {
        expect(estimateTokens(0)).toBe(0);
        expect(estimateTokens(1)).toBe(1);
        expect(estimateTokens(944)).toBe(236);
    });

    test("the turn clock reads seconds, then minutes", () => {
        expect(elapsedText(12_000)).toBe("12s");
        expect(elapsedText(64_000)).toBe("1m 4s");
    });
});

describe("runs of calls", () => {
    const base = (): Block[] => [
        { kind: "user", key: "u1", text: "go" },
        tools("t1", [call("bash", { command: "ls" })]),
        { kind: "thought", key: "th1", text: "hmm", live: false },
        tools("t2", [call("read", { path: "/w/a" })]),
        { kind: "text", key: "x1", text: "found it" },
        tools("t3", [call("bash", { command: "pwd" })]),
        { kind: "text", key: "a1", text: "done" },
    ];

    test("a run is the calls between two stretches of text, keyed by its first tools block in the turn's work", () => {
        const [render] = keepTurns(new Map(), base()).renders;
        const runs = [...(render?.runs ?? new Map())];
        expect(runs.map(([index, run]) => [index, run.calls.length, run.end])).toEqual([[0, 2, 2], [4, 1, 4]]);
    });

    test("reasoning only leaves the turn when the option says so", () => {
        const shown = toTurns(base(), { reasoning: true })[0]?.work.map((block) => block.kind);
        const hidden = toTurns(base(), { reasoning: false })[0]?.work.map((block) => block.kind);
        expect(shown).toEqual(["tools", "thought", "tools", "text", "tools"]);
        expect(hidden).toEqual(["tools", "tools", "text", "tools"]);
        const [render] = keepTurns(new Map(), base(), { reasoning: false }).renders;
        expect([...(render?.runs.values() ?? [])].map((run) => run.calls.length)).toEqual([2, 1]);
    });

    test("a run of landed writes is quiet, and a run with any other call is not", () => {
        const quiet = keepTurns(new Map(), [{ kind: "user", key: "u", text: "x" }, tools("t", [written("/w/index.html")]), { kind: "text", key: "a", text: "ok" }]);
        expect([...quiet.renders[0]!.runs.values()].map((run) => run.quiet)).toEqual([true]);
        const mixed = keepTurns(new Map(), [{ kind: "user", key: "u", text: "x" }, tools("t", [written("/w/index.html"), call("bash", { command: "ls" })]), { kind: "text", key: "a", text: "ok" }]);
        expect([...mixed.renders[0]!.runs.values()].map((run) => run.quiet)).toEqual([false]);
        const failed = keepTurns(new Map(), [{ kind: "user", key: "u", text: "x" }, tools("t", [call("write", { path: "/w/a" }, { state: "failed" })]), { kind: "text", key: "a", text: "ok" }]);
        expect([...failed.renders[0]!.runs.values()].map((run) => run.quiet)).toEqual([false]);
    });

    test("a write that sent only a notice still gets its line", () => {
        const notice = call("write", { path: "/w/big" }, { presentation: { kind: "tool_notice", text: "too large" } });
        const render = keepTurns(new Map(), [{ kind: "user", key: "u", text: "x" }, tools("t", [notice]), { kind: "text", key: "a", text: "ok" }]).renders[0]!;
        expect([...render.runs.values()].map((run) => run.quiet)).toEqual([false]);
    });

    test("a changed reasoning option does not reuse a render built with the other", () => {
        const first = keepTurns(new Map(), base(), { reasoning: true });
        const second = keepTurns(first.byKey, base(), { reasoning: false });
        expect(second.renders[0]).not.toBe(first.renders[0]);
    });
});
