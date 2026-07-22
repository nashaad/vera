import { expect, test } from "bun:test";

import { renderTuiStatusLine } from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
    }, "approve_for_me", "ready")).toBe(
        "ready · gpt-5.6-sol · reasoning high · approve for me",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ask", "ready")).toBe(
        "ready · gpt-5.6-sol · reasoning off · ask",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusLine(
        { model: "gpt-5.6-sol" },
        "full_access",
        "working…",
    )).toBe(
        "working… · gpt-5.6-sol · reasoning default · FULL ACCESS · RED ZONE",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusLine(undefined, undefined, "ready")).toBe(
        "ready · loading · reasoning loading · permissions loading",
    );
});
