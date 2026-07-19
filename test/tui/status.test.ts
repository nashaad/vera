import { expect, test } from "bun:test";

import { renderTuiStatusLine } from "../../clients/tui/status.ts";

test("TUI status line shows host-reported model and reasoning", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
    }, "ready")).toBe(
        "gpt-5.6-sol · thinking high · ready",
    );
});

test("TUI status line shows host-reported reasoning off", () => {
    expect(renderTuiStatusLine({
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
    }, "ready")).toBe(
        "gpt-5.6-sol · thinking off · ready",
    );
});

test("TUI status line identifies host-reported provider-default reasoning", () => {
    expect(renderTuiStatusLine({ model: "gpt-5.6-sol" }, "working…")).toBe(
        "gpt-5.6-sol · thinking default · working…",
    );
});

test("TUI status does not guess settings while the host query is pending", () => {
    expect(renderTuiStatusLine(undefined, "ready")).toBe(
        "model loading · thinking loading · ready",
    );
});
