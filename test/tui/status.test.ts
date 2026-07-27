import { expect, test } from "bun:test";

import {
    countRunningBackgroundAgents,
    renderTuiStatusLine,
} from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        contextWindow: 258_000,
    }, "auto", 64_500, "/workspace", "ready")).toBe(
        "ready · gpt-5.6-sol · reasoning high · /workspace · auto · ctx 25%",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ask", undefined, "/workspace", "ready")).toBe(
        "ready · gpt-5.6-sol · reasoning off · /workspace · ask",
    );
});

test("TUI status starts known context windows at zero percent", () => {
    expect(renderTuiStatusLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
        contextWindow: 131_072,
    }, "auto", undefined, "/workspace", "ready")).toBe(
        "ready · gemma4:26b · reasoning low · /workspace · auto · ctx 0%",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusLine(
        { model: "gpt-5.6-sol" },
        "full_access",
        undefined,
        "/workspace",
        "working…",
    )).toBe(
        "working… · gpt-5.6-sol · reasoning default · /workspace · FULL ACCESS · RED ZONE",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusLine(
        undefined,
        undefined,
        undefined,
        "/workspace",
        "ready",
    )).toBe(
        "ready · loading · reasoning loading · /workspace · permissions loading",
    );
});

test("TUI status shows a compact running background-agent count", () => {
    expect(renderTuiStatusLine(
        { model: "gpt-5.6-sol", reasoningEffort: "high" },
        "auto",
        undefined,
        "/workspace",
        "ready",
        2,
    )).toBe(
        "ready · bg 2 · gpt-5.6-sol · reasoning high · /workspace · auto",
    );
});

test("running background-agent count excludes terminal agents", () => {
    expect(countRunningBackgroundAgents([
        backgroundAgent("working"),
        backgroundAgent("waiting"),
        backgroundAgent("idle"),
        backgroundAgent("completed"),
        backgroundAgent("closed"),
        backgroundAgent("failed"),
        {
            ...backgroundAgent("working"),
            id: "interactive",
            kind: "interactive",
        },
    ])).toBe(3);
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
    };
}
