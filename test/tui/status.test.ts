import { expect, test } from "bun:test";

import {
    countRunningBackgroundAgents,
    renderBackgroundAgentNames,
    renderTuiIdleHint,
    renderTuiStatusDetailsLine,
    renderTuiStatusSegments,
    tuiStatusSnapshot,
} from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
    }, "auto", {
        tokens: 64_500,
        capacity: 258_000,
        estimated: false,
    }, "/workspace")).toBe(
        "gpt-5.6-sol · reasoning high · /workspace · auto · ctx 25%",
    );
});

test("TUI status marks a character-counted measurement as approximate", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
    }, "auto", {
        tokens: 64_500,
        capacity: 258_000,
        estimated: true,
    }, "/workspace")).toBe(
        "gpt-5.6-sol · reasoning high · /workspace · auto · ctx ~25%",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ask", undefined, "/workspace")).toBe(
        "gpt-5.6-sol · reasoning off · /workspace · ask",
    );
});

test("TUI status shows no context share before anything is measured", () => {
    // Zero would be a number nobody measured: the system prompt and the tool
    // definitions occupy the window before the first request is even built.
    expect(renderTuiStatusDetailsLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
        contextWindow: 131_072,
    }, "auto", undefined, "/workspace")).toBe(
        "gemma4:26b · reasoning low · /workspace · auto",
    );
});

test("TUI status shows no context share for a model with no known window", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
    }, "auto", { tokens: 40_000, estimated: true }, "/workspace")).toBe(
        "gemma4:26b · reasoning low · /workspace · auto",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol" },
        "full_access",
        undefined,
        "/workspace",
    )).toBe(
        "gpt-5.6-sol · reasoning default · /workspace · FULL ACCESS · RED ZONE",
    );
});

test("TUI status line prefixes the model with a compact provider label", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol", provider: "cerebras", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
    )).toBe(
        "cerebras/gpt-5.6-sol · reasoning high · /workspace · auto",
    );
});

test("TUI status line omits the provider prefix for an unrecognized provider id", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol", provider: "unknown-provider", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
    )).toBe(
        "gpt-5.6-sol · reasoning high · /workspace · auto",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusDetailsLine(
        undefined,
        undefined,
        undefined,
        "/workspace",
    )).toBe(
        "loading · reasoning loading · /workspace · permissions loading",
    );
});

test("TUI splits activity from persistent details across both footer lines", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "test", reasoningEffort: "low" },
        "ask",
        undefined,
        "/workspace",
        1,
    )).toBe(
        "1 async subagent running · test · reasoning low · /workspace · ask",
    );
    expect(renderTuiStatusDetailsLine(
        { model: "test", reasoningEffort: "low" },
        "ask",
        undefined,
        "/workspace",
        2,
    )).toBe(
        "2 async subagents running · test · reasoning low · /workspace · ask",
    );
});

test("running background-agent count counts the live ones only", () => {
    expect(countRunningBackgroundAgents([
        backgroundAgent("working"),
        backgroundAgent("waiting"),
        // Resident and idle, which is every background session the host
        // restored at startup. Nothing is running in it.
        backgroundAgent("idle"),
        // Live because someone attached to read it, which is not running.
        { ...backgroundAgent("completed"), live: true },
        backgroundAgent("closed"),
        backgroundAgent("failed"),
        {
            ...backgroundAgent("working"),
            id: "interactive",
            kind: "interactive",
        },
    ])).toBe(2);
});

test("background-agent names stack active children and omit finished ones", () => {
    expect(renderBackgroundAgentNames([
        { ...backgroundAgent("working"), parent_id: "main", title: "research" },
        { ...backgroundAgent("waiting"), parent_id: "main", title: "review" },
        { ...backgroundAgent("completed"), parent_id: "main", title: "done" },
        { ...backgroundAgent("working"), parent_id: "other", title: "else" },
    ], "main")).toBe("* research\n* review");
});

test("TUI renders extension segments in its own words", () => {
    expect(renderTuiStatusSegments([
        { kind: "background_agents", running: 2 },
        { kind: "model", model: "gpt-5.6-sol", reasoningEffort: "high" },
        { kind: "workspace", path: "/workspace" },
        { kind: "permissions", mode: "auto" },
        { kind: "context", tokens: 64_500, capacity: 258_000, estimated: true },
        { kind: "note", text: "deploy queued" },
    ])).toBe(
        "2 async subagents running · gpt-5.6-sol · reasoning high · /workspace"
            + " · auto · ctx ~25% · deploy queued",
    );
});

test("TUI drops segments whose facts say nothing", () => {
    // The extension keeps the segment in its list on every repaint; whether
    // zero agents and an idle turn earn a slot is the client's call.
    expect(renderTuiStatusSegments([
        { kind: "turn", state: "idle" },
        { kind: "background_agents", running: 0 },
        { kind: "context", tokens: 400 },
        { kind: "model", model: "gemma4:26b" },
    ])).toBe("gemma4:26b");
});

test("TUI status snapshot carries facts and no client state", () => {
    expect(tuiStatusSnapshot(
        { model: "gpt-5.6-sol", reasoningEffort: "high" },
        "auto",
        { tokens: 64_500, capacity: 258_000, estimated: false },
        "/workspace",
        2,
        "working",
    )).toEqual({
        version: 1,
        turn: "working",
        workspace: "/workspace",
        runningBackgroundAgents: 2,
        model: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        approvalMode: "auto",
        context: { tokens: 64_500, capacity: 258_000, estimated: false },
    });
});

function backgroundAgent(
    status: "idle" | "working" | "waiting" | "completed" | "closed" | "failed",
) {
    return {
        id: `background-${status}`,
        workspace: "/workspace",
        session_path: `/sessions/${status}.jsonl`,
        kind: "background" as const,
        status,
        live: status === "working" || status === "waiting",
    };
}

test("the idle status line reports the background agents still running", () => {
    expect(renderTuiIdleHint("ready · ctrl+p commands", 2))
        .toBe("waiting for 2 background agents · ready · ctrl+p commands");
    expect(renderTuiIdleHint("ready · ctrl+p commands", 1))
        .toBe("waiting for 1 background agent · ready · ctrl+p commands");
    // Back to the plain hint once the children are done.
    expect(renderTuiIdleHint("ready · ctrl+p commands", 0))
        .toBe("ready · ctrl+p commands");
});
