import { expect, test } from "bun:test";

import {
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
        "gpt-5.6-sol · HIGH · ctx 64.5k/258k [██░░░░░░] 25% · auto\n/workspace",
    );
});

test("pane status can own permissions without repeating them in details", () => {
    expect(renderTuiStatusDetailsLine({
        model: "qwen3:1.7b",
        reasoningEffort: "low",
    }, "ask", undefined, "/workspace", 0, undefined, false)).toBe(
        "qwen3:1.7b · LOW\n/workspace",
    );
});

test("TUI status stands the coerced level beside the one asked for", () => {
    expect(renderTuiStatusDetailsLine({
        model: "z-ai/glm-5.2",
        reasoningEffort: "medium",
        requestedReasoningEffort: "xhigh",
    }, "auto", undefined, "/workspace")).toBe(
        "z-ai/glm-5.2 · MEDIUM (ASKED XHIGH) · auto\n/workspace",
    );
});

test("TUI status drops the note once the host publishes no requested level", () => {
    expect(renderTuiStatusDetailsLine({
        model: "z-ai/glm-5.2",
        reasoningEffort: "low",
    }, "auto", undefined, "/workspace")).toBe(
        "z-ai/glm-5.2 · LOW · auto\n/workspace",
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
        "gpt-5.6-sol · HIGH · ctx ~64.5k/258k [██░░░░░░] 25% · auto\n/workspace",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ask", undefined, "/workspace")).toBe(
        "gpt-5.6-sol · OFF · ask\n/workspace",
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
        "gemma4:26b · LOW · auto\n/workspace",
    );
});

test("TUI status shows no context share for a model with no known window", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
    }, "auto", { tokens: 40_000, estimated: true }, "/workspace")).toBe(
        "gemma4:26b · LOW · auto\n/workspace",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol" },
        "full_access",
        undefined,
        "/workspace",
    )).toBe(
        "gpt-5.6-sol · DEFAULT · FULL ACCESS · RED ZONE\n/workspace",
    );
});

test("TUI status line prefixes the model with a compact provider label", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol", provider: "cerebras", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
    )).toBe(
        "cerebras/gpt-5.6-sol · HIGH · auto\n/workspace",
    );
});

test("TUI status line prefixes a declared provider with the name it was given", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gemini-2.5-flash", provider: "gemini", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
    )).toBe(
        "gemini/gemini-2.5-flash · HIGH · auto\n/workspace",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusDetailsLine(
        undefined,
        undefined,
        undefined,
        "/workspace",
    )).toBe(
        "loading · LOADING · permissions loading\n/workspace",
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
        "1 async subagent running · test · LOW · ask\n/workspace",
    );
    expect(renderTuiStatusDetailsLine(
        { model: "test", reasoningEffort: "low" },
        "ask",
        undefined,
        "/workspace",
        2,
    )).toBe(
        "2 async subagents running · test · LOW · ask\n/workspace",
    );
});

test("TUI renders extension segments in its own words", () => {
    expect(renderTuiStatusSegments([
        { kind: "background_agents", running: 2 },
        { kind: "model", model: "gpt-5.6-sol", reasoningEffort: "high" },
        { kind: "workspace", path: "/workspace" },
        { kind: "permissions", mode: "auto" },
        { kind: "context", tokens: 64_500, capacity: 258_000, estimated: true },
        { kind: "free_note", text: "deploy queued" },
    ])).toBe(
        "2 async subagents running · gpt-5.6-sol · reasoning high · /workspace"
            + " · auto · ctx ~64.5k/258k [██░░░░░░] 25% · deploy queued",
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

test("the idle status line reports the background agents still running", () => {
    expect(renderTuiIdleHint("ready · ctrl+p commands", 2))
        .toBe("waiting for 2 background agents · ready · ctrl+p commands");
    expect(renderTuiIdleHint("ready · ctrl+p commands", 1))
        .toBe("waiting for 1 background agent · ready · ctrl+p commands");
    // Back to the plain hint once the children are done.
    expect(renderTuiIdleHint("ready · ctrl+p commands", 0))
        .toBe("ready · ctrl+p commands");
});
