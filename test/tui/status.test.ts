import { expect, test } from "bun:test";
import { homedir } from "node:os";

import {
    needsYouChipColumns,
    renderTuiCompactionHint,
    renderTuiIdleHint,
    tuiPlaceRowModeLine,
    renderTuiFileViewStatusRows,
    renderTuiStatusDetailsLine,
    renderTuiStatusDetailsRows,
    renderTuiStatusSegments,
    tuiStatusSnapshot,
} from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        contextWindow: 258_000,
    }, "auto", {
        tokens: 64_500,
        capacity: 258_000,
        estimated: false,
    }, "/workspace")).toBe(
        "default · auto · ctx 64.5k/258k ▰▰▰▱▱▱▱▱▱▱  25% · gpt-5.6-sol · high\n/workspace",
    );
});

test("pane status can own permissions without repeating them in details", () => {
    expect(renderTuiStatusDetailsLine({
        model: "qwen3:1.7b",
        reasoningEffort: "low",
    }, "ask", undefined, "/workspace", 0, undefined, false)).toBe(
        "default · qwen3:1.7b · low\n/workspace",
    );
});

test("TUI status stands the coerced level beside the one asked for", () => {
    expect(renderTuiStatusDetailsLine({
        model: "z-ai/glm-5.2",
        reasoningEffort: "medium",
        requestedReasoningEffort: "xhigh",
    }, "auto", undefined, "/workspace")).toBe(
        "default · auto · z-ai/glm-5.2 · medium (asked xhigh)\n/workspace",
    );
});

test("TUI status drops the note once the host publishes no requested level", () => {
    expect(renderTuiStatusDetailsLine({
        model: "z-ai/glm-5.2",
        reasoningEffort: "low",
    }, "auto", undefined, "/workspace")).toBe(
        "default · auto · z-ai/glm-5.2 · low\n/workspace",
    );
});

test("TUI status marks a character-counted measurement as approximate", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        contextWindow: 258_000,
    }, "auto", {
        tokens: 64_500,
        capacity: 258_000,
        estimated: true,
    }, "/workspace")).toBe(
        "default · auto · ctx ~64.5k/258k ▰▰▰▱▱▱▱▱▱▱  25% · gpt-5.6-sol · high\n/workspace",
    );
});

test("TUI status context max follows the selected model before the next turn", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        contextWindow: 204_800,
    }, "auto", {
        tokens: 64_500,
        capacity: 258_000,
        estimated: true,
    }, "/workspace")).toBe(
        "default · auto · ctx ~64.5k/204.8k ▰▰▰▱▱▱▱▱▱▱  31% · gpt-5.6-sol · high\n/workspace",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ask", undefined, "/workspace")).toBe(
        "default · ask · gpt-5.6-sol · off\n/workspace",
    );
});

test("TUI status marks context as unknown before anything is measured", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
        contextWindow: 131_072,
    }, "auto", undefined, "/workspace")).toBe(
        "default · auto · ctx ?% · gemma4:26b · low\n/workspace",
    );
});

test("TUI status shows no context share for a model with no known window", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
    }, "auto", { tokens: 40_000, estimated: true }, "/workspace")).toBe(
        "default · auto · gemma4:26b · low\n/workspace",
    );
});

test("TUI status does not present the user ceiling as an unknown model's max", () => {
    expect(renderTuiStatusDetailsLine({
        model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
        contextLimit: 204_800,
    }, "auto", {
        tokens: 20_000,
        capacity: 204_800,
        estimated: true,
    }, "/workspace")).toBe(
        "default · auto · unsloth/Qwen3.6-35B-A3B-MTP-GGUF · default\n/workspace",
    );
});

test("TUI status caps a known window by the user ceiling", () => {
    expect(renderTuiStatusDetailsLine({
        model: "qwen-local",
        contextWindow: 32_768,
        contextLimit: 204_800,
    }, "auto", {
        tokens: 20_000,
        capacity: 204_800,
        estimated: true,
    }, "/workspace")).toBe(
        "default · auto · ctx ~20k/32.8k ▰▰▰▰▰▰▱▱▱▱  61% · qwen-local · default\n/workspace",
    );
    expect(renderTuiStatusDetailsLine({
        model: "qwen-local",
        contextWindow: 32_768,
        contextLimit: 8_192,
    }, "auto", {
        tokens: 4_000,
        estimated: false,
    }, "/workspace")).toBe(
        "default · auto · ctx 4k/8.2k ▰▰▰▰▰▱▱▱▱▱  49% · qwen-local · default\n/workspace",
    );
});

test("TUI status drops the previous model's max when the next window is unknown", () => {
    const lastMeasurement = {
        tokens: 20_000,
        capacity: 32_768,
        estimated: true,
    };
    expect(renderTuiStatusDetailsLine({
        model: "qwen-local",
        contextWindow: 32_768,
    }, "auto", lastMeasurement, "/workspace")).toBe(
        "default · auto · ctx ~20k/32.8k ▰▰▰▰▰▰▱▱▱▱  61% · qwen-local · default\n/workspace",
    );
    expect(renderTuiStatusDetailsLine({
        model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
        contextLimit: 204_800,
    }, "auto", lastMeasurement, "/workspace")).toBe(
        "default · auto · unsloth/Qwen3.6-35B-A3B-MTP-GGUF · default\n/workspace",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol" },
        "full_access",
        undefined,
        "/workspace",
    )).toBe(
        "default · FULL ACCESS · RED ZONE · gpt-5.6-sol · default\n/workspace",
    );
});

test("TUI status line prefixes the model with a compact provider label", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gpt-5.6-sol", provider: "cerebras", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
    )).toBe(
        "default · auto · cerebras/gpt-5.6-sol · high\n/workspace",
    );
});

test("TUI status line prefixes a declared provider with the name it was given", () => {
    expect(renderTuiStatusDetailsLine(
        { model: "gemini-2.5-flash", provider: "gemini", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
    )).toBe(
        "default · auto · gemini/gemini-2.5-flash · high\n/workspace",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusDetailsLine(
        undefined,
        undefined,
        undefined,
        "/workspace",
    )).toBe(
        "default · permissions loading · loading · loading\n/workspace",
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
        "1 async subagent running · default · ask · test · low\n/workspace",
    );
    expect(renderTuiStatusDetailsLine(
        { model: "test", reasoningEffort: "low" },
        "ask",
        undefined,
        "/workspace",
        2,
    )).toBe(
        "2 async subagents running · default · ask · test · low\n/workspace",
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
            + " · auto · ctx ~64.5k/258k ▰▰▰▱▱▱▱▱▱▱  25% · deploy queued",
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
        { model: "gpt-5.6-sol", reasoningEffort: "high", contextWindow: 258_000 },
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
    // Ready is the place row's to say, and the place row still says it here:
    // a session waiting on its children is idle.
    expect(renderTuiIdleHint("ready · Ctrl+P commands", 2))
        .toBe("waiting for 2 background agents");
    expect(renderTuiIdleHint("ready · Ctrl+P commands", 1))
        .toBe("waiting for 1 background agent");
    // Back to the plain hint once the children are done.
    expect(renderTuiIdleHint("ready · Ctrl+P commands", 0))
        .toBe("ready · Ctrl+P commands");
});

test("the place row keeps ready off the band while a turn is live", () => {
    expect(tuiPlaceRowModeLine("ready · Ctrl+P commands", true))
        .toBe("ready · Ctrl+P commands");
    expect(tuiPlaceRowModeLine("ready · Ctrl+P commands", false)).toBe("");
    expect(tuiPlaceRowModeLine(
        "ready · Ctrl+P commands",
        false,
        ["agent mode", "split", "Ctrl+\\ layout"],
    )).toBe("agent mode · split · Ctrl+\\ layout");
    expect(tuiPlaceRowModeLine(
        "ready · Ctrl+P commands",
        true,
        ["agent mode", "vera only", "Ctrl+\\ layout"],
    )).toBe(
        "ready · Ctrl+P commands · agent mode · vera only · Ctrl+\\ layout",
    );
});

test("the compaction hint sweeps a segment left and right", () => {
    expect(renderTuiCompactionHint(0)).toBe("compacting ━━━─────── · 0s");
    expect(renderTuiCompactionHint(300)).toBe("compacting ───━━━──── · 0s");
    expect(renderTuiCompactionHint(700)).toBe("compacting ───────━━━ · 0s");
    // Past the right edge it turns back.
    expect(renderTuiCompactionHint(1_000)).toBe("compacting ────━━━─── · 1s");
    expect(renderTuiCompactionHint(1_400)).toBe("compacting ━━━─────── · 1s");
});

test("the compaction hint drops the sweep when animation is off", () => {
    expect(renderTuiCompactionHint(5_000, {}, false)).toBe("compacting · 5s");
});

test("the compaction hint names its strategy and summarizer model", () => {
    expect(renderTuiCompactionHint(2_800, {
        strategy: "vera/full-summary",
        provider: "openrouter",
        model: "openai/gpt-5.6-terra",
    })).toBe(
        "compacting ━━━─────── · vera/full-summary"
            + " · openrouter/openai/gpt-5.6-terra · 2s",
    );
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
        .toBe("1 need you · Ctrl+Shift+J".length);
    // An empty hint leaves the count alone rather than a dangling separator.
    expect(text(rows(""))).toContain("1 need you · default · auto · ctx ?% · test");
    expect(needsYouChipColumns(rows(""), 1)).toBe("1 need you".length);
});

test("a file view status names the place and not a loading host", () => {
    const rows = renderTuiFileViewStatusRows("/workspace", "main");
    expect(rows.map((row) => row.map((chunk) => chunk.text).join(""))).toEqual([
        "",
        "/workspace · main",
    ]);
    expect(renderTuiFileViewStatusRows("/workspace").map((row) =>
        row.map((chunk) => chunk.text).join("")
    )).toEqual(["", "/workspace"]);
});

test("the footer carries agent, access, model and effort whether or not a dial was touched", () => {
    const line = renderTuiStatusDetailsLine(
        { model: "claude-opus-5", provider: "anthropic", reasoningEffort: "high" },
        "ask",
        undefined,
        "/workspace",
    );
    expect(line.split("\n")[0]).toBe(
        "default · ask · anthropic/claude-opus-5 · high",
    );
    const named = renderTuiStatusDetailsLine(
        { model: "claude-opus-5", provider: "anthropic", reasoningEffort: "high" },
        "ask",
        undefined,
        "/workspace",
        0,
        undefined,
        true,
        undefined,
        { agent: "build" },
    );
    expect(named.split("\n")[0]).toBe(
        "build · ask · anthropic/claude-opus-5 · high",
    );
});

test("agent and access sit left, model and effort right, padded to the width", () => {
    const row = renderTuiStatusDetailsRows(
        { model: "claude-opus-5", provider: "anthropic", reasoningEffort: "high" },
        "ask",
        undefined,
        "/workspace",
        0,
        undefined,
        true,
        undefined,
        { agent: "build" },
        0,
        60,
    )[0] ?? [];
    const text = row.map((chunk) => chunk.text).join("");
    expect(text.length).toBe(60);
    expect(text.startsWith("build · ask ")).toBe(true);
    expect(text.endsWith("anthropic/claude-opus-5 · high")).toBe(true);
});

test("the activity strip sits at the right end of the workspace row", () => {
    const rows = renderTuiStatusDetailsRows(
        { model: "claude-opus-5", provider: "anthropic", reasoningEffort: "high" },
        "ask",
        undefined,
        "/workspace",
        0,
        undefined,
        true,
        undefined,
        { agent: "build" },
        0,
        60,
        undefined,
        [{ text: "▒▓█", tone: "accent", color: "#e0703e" }],
    );
    const [first, second] = rows.map((row) => row.map((chunk) => chunk.text).join(""));
    expect(first?.includes("▒▓█")).toBe(false);
    expect(second?.length).toBe(60);
    expect(second?.startsWith("/workspace ")).toBe(true);
    expect(second?.endsWith(" ▒▓█")).toBe(true);
});

test("too narrow to pad, the two ends read as one row rather than wrap", () => {
    const row = renderTuiStatusDetailsRows(
        { model: "claude-opus-5", provider: "anthropic", reasoningEffort: "high" },
        "ask",
        undefined,
        "/workspace",
        0,
        undefined,
        true,
        undefined,
        { agent: "build" },
        0,
        20,
    )[0] ?? [];
    expect(row.map((chunk) => chunk.text).join("")).toBe(
        "build · ask · anthropic/claude-opus-5 · high",
    );
});

test("activity_strip_position composer puts the strip after agent and access", () => {
    const rows = renderTuiStatusDetailsRows(
        { model: "claude-opus-5", provider: "anthropic", reasoningEffort: "high" },
        "ask",
        undefined,
        "/workspace",
        0,
        undefined,
        true,
        undefined,
        { agent: "build" },
        0,
        60,
        undefined,
        [{ text: "▒▓█", tone: "accent", color: "#e0703e" }],
        "composer",
    );
    const [first, second] = rows.map((row) => row.map((chunk) => chunk.text).join(""));
    expect(first?.length).toBe(60);
    expect(first?.startsWith("build · ask  ▒▓█ ")).toBe(true);
    expect(second).toBe("/workspace");
});

test("any measured context fills at least one meter cell", () => {
    const line = (tokens: number) => renderTuiStatusDetailsLine({
        model: "gpt-6-luna",
        reasoningEffort: "low",
        contextWindow: 272_000,
    }, "auto", { tokens, capacity: 272_000, estimated: true }, "/workspace");
    expect(line(4_800)).toContain("ctx ~4.8k/272k ▰▱▱▱▱▱▱▱▱▱  2%");
    expect(line(0)).toContain("ctx ~0/272k ▱▱▱▱▱▱▱▱▱▱  0%");
});

test("a narrow composer row drops token counts before model or effort", () => {
    const rows = (width: number) => renderTuiStatusDetailsRows(
        { model: "gpt-6-luna", reasoningEffort: "low", contextWindow: 272_000 },
        "auto",
        { tokens: 4_800, capacity: 272_000, estimated: true },
        "/workspace",
        0,
        undefined,
        true,
        undefined,
        {},
        0,
        width,
    )[0]!.map((chunk) => chunk.text).join("");
    expect(rows(92)).toContain("ctx ~4.8k/272k ▰▱▱▱▱▱▱▱▱▱  2%");
    const narrow = rows(60);
    expect(Bun.stringWidth(narrow)).toBe(60);
    expect(narrow).not.toContain("4.8k");
    expect(narrow).toContain("ctx ▰▱▱▱▱▱▱▱▱▱  2%");
    expect(narrow.endsWith("gpt-6-luna · low")).toBe(true);
});

test("a narrow workspace row shortens the path and keeps it when a turn starts", () => {
    const place = (activity: readonly { text: string; tone: "accent" }[]) => renderTuiStatusDetailsRows(
        { model: "gpt-6-luna", reasoningEffort: "low" },
        "auto",
        undefined,
        `${homedir()}/Projects/vera/.worktrees/limits`,
        0,
        undefined,
        true,
        "feat/subscription-limits",
        {},
        0,
        62,
        undefined,
        activity,
        "corner",
        "ready · Ctrl+P commands".length,
    )[1]!.map((chunk) => chunk.text).join("");
    expect(place([])).toBe("…/limits · feat/subscription-limits");
    const working = place([{ text: "▒██▓░░", tone: "accent" }]);
    expect(working.startsWith("…/limits · feat/subscription-limits ")).toBe(true);
    expect(working.endsWith(" ▒██▓░░")).toBe(true);
    expect(Bun.stringWidth(working)).toBe(62);
    const wide = renderTuiStatusDetailsRows(
        undefined, "auto", undefined, `${homedir()}/Projects/vera/.worktrees/limits`,
        0, undefined, true, "feat/subscription-limits", {}, 0, 92, undefined, [], "corner", 23,
    )[1]!.map((chunk) => chunk.text).join("");
    expect(wide).toBe("~/Projects/vera/.worktrees/limits · feat/subscription-limits");
    const tiny = renderTuiStatusDetailsRows(
        undefined, "auto", undefined, `${homedir()}/Projects/vera/.worktrees/limits`,
        0, undefined, true, "feat/subscription-limits", {}, 0, 50, undefined, [], "corner", 23,
    )[1]!.map((chunk) => chunk.text).join("");
    expect(tiny).toBe("…/limits · feat/subscrip…");
    expect(Bun.stringWidth(tiny)).toBe(50 - 23 - 2);
});
