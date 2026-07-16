import { expect, test } from "bun:test";

import { renderTuiStatusLine } from "../../clients/tui/status.ts";

test("TUI status line shows the model and configured reasoning effort", () => {
    expect(renderTuiStatusLine("gpt-5.6-sol", "medium", "ready")).toBe(
        "gpt-5.6-sol · thinking medium · ready",
    );
});

test("TUI status line identifies provider-default reasoning", () => {
    expect(renderTuiStatusLine("gpt-5.6-sol", undefined, "working…")).toBe(
        "gpt-5.6-sol · thinking default · working…",
    );
});
