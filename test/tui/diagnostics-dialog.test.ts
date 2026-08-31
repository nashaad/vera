import { expect, test } from "bun:test";

import {
    handleTuiDiagnosticsDialogKey,
    inspectDialogFrame,
    inspectDocumentLines,
    INSPECT_COPY_HINT,
    INSPECT_DIALOG_MAX_WIDTH,
    styledInspectDocument,
} from "../../clients/tui/diagnostics-dialog.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_SUCCESS,
    TUI_DANGER,
} from "../../clients/tui/state.ts";
import { parseColor } from "@opentui/core";

test("diagnostics dialog copies on Enter and dismisses on Escape", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "enter" })).toBe("copy");
    expect(handleTuiDiagnosticsDialogKey({ name: "return" })).toBe("copy");
    expect(handleTuiDiagnosticsDialogKey({ name: "escape" })).toBe("dismiss");
});

test("diagnostics dialog switches scope with Tab", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "tab" }, true))
        .toBe("switch_scope");
    expect(handleTuiDiagnosticsDialogKey({ name: "tab", shift: true }, true))
        .toBe("switch_scope");
    expect(handleTuiDiagnosticsDialogKey({ name: "tab" }))
        .toBeUndefined();
});

test("diagnostics dialog runs provider health on v only when allowed", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "v" }, true, true))
        .toBe("check_health");
    expect(handleTuiDiagnosticsDialogKey({ name: "v" }, true))
        .toBeUndefined();
    expect(handleTuiDiagnosticsDialogKey({ name: "v" }))
        .toBeUndefined();
});

test("diagnostics dialog leaves unrelated and modified keys alone", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "a" })).toBeUndefined();
    expect(handleTuiDiagnosticsDialogKey({ name: "enter", ctrl: true }))
        .toBeUndefined();
});

test("inspect dialog keeps Markdown tables and quotes as source", () => {
    expect(inspectDocumentLines([
        "# Usage",
        "## Session usage",
        "| Calls | Runtime |",
        "| --- | --- |",
        "| 1 | 2.69s |",
        "",
        "> Provider did not report cost.",
    ].join("\n"))).toEqual([
        "## Session usage",
        "| Calls | Runtime |",
        "| --- | --- |",
        "| 1 | 2.69s |",
        "",
        "> Provider did not report cost.",
    ]);
});

test("inspect copy hint names section drag and copy-all", () => {
    expect(INSPECT_COPY_HINT).toContain("drag a section");
    expect(INSPECT_COPY_HINT).toContain("enter copies all");
});

test("inspect occupancy cells reuse the status ctx meter colors", () => {
    const styled = styledInspectDocument([
        "# Context",
        "## CONTEXT USAGE",
        "█░▒",
        "──────────",
        "> !  AGENTS.local.md is 43 KB and rides every turn.",
        "/context [all] to expand",
    ].join("\n"));
    const color = (text: string) =>
        styled.chunks.find((chunk) => chunk.text.toString() === text)?.fg;

    expect(color("## CONTEXT USAGE")).toEqual(parseColor(TUI_ACCENT));
    expect(color("█")).toEqual(parseColor(TUI_ACCENT));
    expect(color("░")).toEqual(parseColor(TUI_ELEMENT));
    expect(color("▒")).toEqual(parseColor(TUI_NOTICE));
    expect(color("──────────")).toEqual(parseColor(TUI_MUTED));
    expect(color("> !  AGENTS.local.md is 43 KB and rides every turn."))
        .toEqual(parseColor(TUI_NOTICE));
    expect(color("/context [all] to expand")).toEqual(parseColor(TUI_MUTED));
});

test("inspect health tones keep the word and decorate it", () => {
    const styled = styledInspectDocument([
        "# Session diagnostics",
        "  green    openrouter/glm-flash answered",
        "  yellow   only the last shortlist model answered",
        "  red      no provider configured",
    ].join("\n"));
    const color = (text: string) =>
        styled.chunks.find((chunk) => chunk.text.toString() === text)?.fg;

    expect(color("green")).toEqual(parseColor(TUI_SUCCESS));
    expect(color("yellow")).toEqual(parseColor(TUI_NOTICE));
    expect(color("red")).toEqual(parseColor(TUI_DANGER));
});

test("the inspect dialog is a capped column, not a full-bleed pane", () => {
    expect(inspectDialogFrame(48)).toEqual({ left: 2, width: 44 });
    expect(inspectDialogFrame(80)).toEqual({
        left: Math.floor((80 - INSPECT_DIALOG_MAX_WIDTH) / 2),
        width: INSPECT_DIALOG_MAX_WIDTH,
    });
    expect(inspectDialogFrame(120).width).toBe(INSPECT_DIALOG_MAX_WIDTH);
    expect(inspectDialogFrame(120).left).toBeGreaterThan(inspectDialogFrame(80).left);
});
