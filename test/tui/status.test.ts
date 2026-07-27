import { expect, test } from "bun:test";

import {
    countRunningBackgroundAgents,
    renderTuiStatusDetailsLine,
} from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        contextWindow: 258_000,
    }, "auto", 64_500, "/workspace")).toBe(
        "gpt-5.6-sol · reasoning high · /workspace · auto · ctx 25%",
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

test("TUI status starts known context windows at zero percent", () => {
    expect(renderTuiStatusDetailsLine({
        model: "gemma4:26b",
        reasoningEffort: "low",
        contextWindow: 131_072,
    }, "auto", undefined, "/workspace")).toBe(
        "gemma4:26b · reasoning low · /workspace · auto · ctx 0%",
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
        "1 background agent running · test · reasoning low · /workspace · ask",
    );
    expect(renderTuiStatusDetailsLine(
        { model: "test", reasoningEffort: "low" },
        "ask",
        undefined,
        "/workspace",
        2,
    )).toBe(
        "2 background agents running · test · reasoning low · /workspace · ask",
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
