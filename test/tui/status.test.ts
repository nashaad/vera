import { expect, test } from "bun:test";

import { renderTuiStatusLine } from "../../clients/tui/status.ts";

test("TUI status line shows the model and configured reasoning effort", () => {
    expect(renderTuiStatusLine("gpt-5.6-sol", {
        requested: "high",
        providerEffort: "high",
        inferred: false,
    }, "ready")).toBe(
        "gpt-5.6-sol · thinking high · ready",
    );
});

test("TUI status line shows a different curated provider effort", () => {
    expect(renderTuiStatusLine("gpt-5.6-sol", {
        requested: "max",
        providerEffort: "xhigh",
        inferred: false,
    }, "ready")).toBe(
        "gpt-5.6-sol · thinking max → xhigh · ready",
    );
});

test("TUI status line labels an inferred provider effort", () => {
    expect(renderTuiStatusLine("provider/model", {
        requested: "high",
        providerEffort: "magna",
        inferred: true,
    }, "ready")).toBe(
        "provider/model · thinking high → magna (inferred) · ready",
    );
});

test("TUI status line shows explicit off mapping", () => {
    expect(renderTuiStatusLine("gpt-5.6-sol", {
        requested: "off",
        providerEffort: "none",
        inferred: false,
    }, "ready")).toBe(
        "gpt-5.6-sol · thinking off → none · ready",
    );
});

test("TUI status line identifies provider-default reasoning", () => {
    expect(renderTuiStatusLine("gpt-5.6-sol", undefined, "working…")).toBe(
        "gpt-5.6-sol · thinking default · working…",
    );
});
