import { expect, test } from "bun:test";

import { renderTuiStatusLine } from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
    }, "approve_for_me", "ready")).toBe(
        "gpt-5.6-sol · thinking high · permissions approve_for_me · ready",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ask", "ready")).toBe(
        "gpt-5.6-sol · thinking off · permissions ask · ready",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusLine(
        { model: "gpt-5.6-sol" },
        "full_access",
        "working…",
    )).toBe(
        "gpt-5.6-sol · thinking default · permissions full_access · working…",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusLine(undefined, undefined, "ready")).toBe(
        "loading · thinking loading · permissions loading · ready",
    );
});
