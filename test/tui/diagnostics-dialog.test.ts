import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiDiagnosticsDialogView,
    handleTuiDiagnosticsDialogKey,
    inspectDialogFrame,
    inspectDocumentMarkdown,
    inspectDocumentLines,
    INSPECT_COPY_HINT,
    INSPECT_DIALOG_MAX_WIDTH,
    styledInspectOccupancy,
} from "../../clients/tui/diagnostics-dialog.ts";
import { parseColor } from "@opentui/core";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_NOTICE,
} from "../../clients/tui/state.ts";

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

test("inspect document markdown omits only its redundant H1", () => {
    expect(inspectDocumentMarkdown([
        "# Session diagnostics",
        "## Session",
        "body",
    ].join("\n"))).toBe("## Session\nbody");
    expect(inspectDocumentMarkdown("# Visible\nbody", false))
        .toBe("# Visible\nbody");
});

test("rendered context occupancy keeps its three capacity colors", () => {
    const styled = styledInspectOccupancy("█ used  ░ free  ▒ reserve");
    const color = (text: string) =>
        styled.chunks.find((chunk) => chunk.text.toString() === text)?.fg;

    expect(color("█")).toEqual(parseColor(TUI_ACCENT));
    expect(color("░")).toEqual(parseColor(TUI_ELEMENT));
    expect(color("▒")).toEqual(parseColor(TUI_NOTICE));
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

test("the inspect dialog renders markdown and wraps an overflowing value", async () => {
    const setup = await createTestRenderer({ width: 48, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer, {
        showScopeTabs: true,
    });
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({
        text: [
            "# Session diagnostics",
            "## Session",
            "  identity     misty-knoll:3574",
            "  file         /Users/nash/.vera/profiles/default/runtime/sessions/session.jsonl",
            "",
            "## Usage",
            "| Metric | Value |",
            "| --- | --- |",
            "| Calls | 583 |",
        ].join("\n"),
    });

    try {
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Session");
        expect(frame).not.toContain("## Session");
        expect(frame).not.toContain("| Metric | Value |");
        expect(frame).toContain("Metric  Value");
        expect(frame).toContain("/Users/nash/.vera/");
        expect(frame).toContain("profiles/default/runtime/sessions/");
        expect(frame).toContain("session.jsonl");
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});

test("an open inspect dialog recenters after the terminal resizes", async () => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({ text: "# Report\nbody" });
    expect(view.box.left).toBe(24);
    expect(view.box.width).toBe(INSPECT_DIALOG_MAX_WIDTH);

    try {
        setup.resize(80, 30);
        view.update({ text: "# Report\nbody" });
        expect(view.box.left).toBe(4);
        expect(view.box.width).toBe(INSPECT_DIALOG_MAX_WIDTH);
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});
