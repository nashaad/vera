import { expect, test } from "bun:test";

import {
    needsYouChipColumns,
    renderTuiCompactionHint,
    renderTuiIdleHint,
    renderTuiStatusDetailsLine,
    renderTuiStatusDetailsRows,
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

test("the compaction hint fills with time and never completes on its own", () => {
    expect(renderTuiCompactionHint(0)).toBe("compacting [░░░░░░░░░░░░] · 0s");
    // Half life: 20s of elapsed time fills half the bar.
    expect(renderTuiCompactionHint(20_000))
        .toBe("compacting [██████░░░░░░] · 20s");
    // The fill grows monotonically with elapsed time.
    const fills = [1_000, 5_000, 30_000, 120_000, 600_000].map((ms) =>
        renderTuiCompactionHint(ms).split("█").length - 1
    );
    expect([...fills].sort((a, b) => a - b)).toEqual(fills);
    // Only the finish completes the bar: elapsed time alone leaves a gap.
    expect(renderTuiCompactionHint(Number.MAX_SAFE_INTEGER))
        .toContain("░");
});

test("the status line leads with what needs you, and says nothing when nothing does", () => {
    const line = (needsYou: number): string =>
        renderTuiStatusDetailsLine(
            { model: "test", reasoningEffort: "high", contextWindow: 100 },
            "auto",
            undefined,
            "/work/one",
            0,
            undefined,
            true,
            undefined,
            {},
            needsYou,
        );

    expect(line(0)).not.toContain("need you");
    expect(line(1)).toContain("1 need you");
    expect(line(3)).toContain("3 need you");
    // Ahead of the model, because it is the only thing on the row that is
    // asking for something.
    expect(line(2).indexOf("2 need you")).toBeLessThan(line(2).indexOf("test"));
});

test("what needs you sits beside running subagents rather than replacing them", () => {
    const line = renderTuiStatusDetailsLine(
        { model: "test", reasoningEffort: "high", contextWindow: 100 },
        "auto",
        undefined,
        "/work/one",
        2,
        undefined,
        true,
        undefined,
        {},
        1,
    );

    expect(line).toContain("1 need you");
    expect(line).toContain("2 async subagents running");
});

test("the attention chip names /work, and drops the hint before the count", () => {
    const rows = (width: number | undefined) =>
        renderTuiStatusDetailsRows(
            { model: "test", reasoningEffort: "high", contextWindow: 100 },
            "auto",
            undefined,
            "/work/one",
            0,
            undefined,
            true,
            undefined,
            {},
            1,
            width,
        );
    const rowText = (row: readonly { text: string }[]): string =>
        row.map((chunk) => chunk.text).join("");

    // Room to spare: the count and the command both show.
    const wide = rows(undefined)[0] ?? [];
    expect(rowText(wide)).toContain("1 need you · /work");
    // Too narrow for the whole row: the command goes, the count stays.
    const tight = rows(20)[0] ?? [];
    expect(rowText(tight)).toContain("1 need you");
    expect(rowText(tight)).not.toContain("/work");
});

test("the chip's click span covers the count and the hint, and only them", () => {
    const rows = (needsYou: number, width?: number) =>
        renderTuiStatusDetailsRows(
            { model: "test", reasoningEffort: "high", contextWindow: 100 },
            "auto",
            undefined,
            "/work/one",
            0,
            undefined,
            true,
            undefined,
            {},
            needsYou,
            width,
        )[0] ?? [];

    expect(needsYouChipColumns(rows(0), 0)).toBe(0);
    expect(needsYouChipColumns(rows(1), 1)).toBe("1 need you · /work".length);
    // With the hint dropped, the span shrinks to the count alone.
    expect(needsYouChipColumns(rows(1, 20), 1)).toBe("1 need you".length);
});

test("the attention hint is the caller's, so it can name the jump chord", () => {
    const rows = (hint: string) =>
        renderTuiStatusDetailsRows(
            { model: "test", reasoningEffort: "high", contextWindow: 100 },
            "auto",
            undefined,
            "/work/one",
            0,
            undefined,
            true,
            undefined,
            {},
            1,
            undefined,
            hint,
        )[0] ?? [];
    const text = (row: readonly { text: string }[]): string =>
        row.map((chunk) => chunk.text).join("");

    const chord = rows("ctrl+shift+j");
    expect(text(chord)).toContain("1 need you · ctrl+shift+j");
    // The click span follows whatever hint is shown.
    expect(needsYouChipColumns(chord, 1))
        .toBe("1 need you · ctrl+shift+j".length);
    // An empty hint leaves the count alone rather than a dangling separator.
    expect(text(rows(""))).toContain("1 need you · test");
    expect(needsYouChipColumns(rows(""), 1)).toBe("1 need you".length);
});
