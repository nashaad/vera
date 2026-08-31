import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiDiagnosticsDialogView,
    handleTuiDiagnosticsDialogKey,
    inspectMarkdownStyle,
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
    TUI_MUTED,
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

test("inspect labels recede but keep their structural weight", () => {
    const style = inspectMarkdownStyle();
    try {
        for (const scope of [
            "markup.heading",
            "markup.heading.1",
            "markup.heading.2",
            "markup.heading.3",
        ]) {
            expect(style.getStyle(scope)?.fg).toEqual(parseColor(TUI_MUTED));
            expect(style.getStyle(scope)?.bold).toBe(true);
        }
        expect(style.getStyle("punctuation.special")?.fg)
            .toEqual(parseColor(TUI_ELEMENT));
    } finally {
        style.destroy();
    }
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
            "| Field | Value |",
            "| --- | --- |",
            "| Identity | misty-knoll:3574 |",
            "| File | `/Users/nash/.vera/profiles/default/runtime/sessions/session.jsonl` |",
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
        expect(frame).not.toContain("Field  Value");
        expect(frame).not.toContain("| Metric | Value |");
        expect(frame).toContain("Metric  Value");
        expect(frame).not.toContain("`/Users/nash");
        const lines = frame.split("\n");
        const firstIndex = lines.findIndex((line) => line.includes("/Users/nash"));
        const first = lines[firstIndex];
        const second = lines[firstIndex + 1];
        const third = lines[firstIndex + 2];
        expect(first).toContain("/Users/nash/.vera/profil");
        expect(second).toContain("default/runtime/sessions/");
        expect(third).toContain("session.jsonl");
        expect(second!.indexOf("default/runtime"))
            .toBe(first!.indexOf("/Users/nash"));
        expect(third!.indexOf("session.jsonl"))
            .toBe(first!.indexOf("/Users/nash"));
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

test("inspect content width shrinks before layout catches up", async () => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        await setup.flush();
        const wide = view.contentWidth();
        setup.resize(64, 30);
        const narrow = view.contentWidth();

        expect(narrow).toBeLessThan(wide);
        expect(narrow).toBeLessThanOrEqual(inspectDialogFrame(64).width - 5);
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});
