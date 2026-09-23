import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiDiagnosticsDialogView,
    handleTuiDiagnosticsDialogKey,
    inspectMarkdownStyle,
    inspectDialogFrame,
    inspectDocumentMarkdown,
    inspectDocumentLines,
    sourceMarkdownStyle,
    splitFrontmatter,
    INSPECT_COPY_HINT,
    styledInspectDanger,
    styledInspectHealth,
    styledInspectOccupancy,
} from "../../clients/tui/diagnostics-dialog.ts";
import { parseColor } from "@opentui/core";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_SUCCESS,
    TUI_DANGER,
    TUI_TEXT,
} from "../../clients/tui/state.ts";

test("diagnostics dialog copies on Enter and dismisses on Escape", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "enter" })).toBe("copy");
    expect(handleTuiDiagnosticsDialogKey({ name: "return" })).toBe("copy");
    expect(handleTuiDiagnosticsDialogKey({ name: "escape" })).toBe("dismiss");
});

test("the diagnostics menu chooses with ↑↓, opens on Enter, and closes on Escape", () => {
    const menu = (name: string) =>
        handleTuiDiagnosticsDialogKey({ name }, true, true, true);
    expect(menu("up")).toBe("previous_scope");
    expect(menu("down")).toBe("next_scope");
    expect(menu("return")).toBe("open");
    expect(menu("escape")).toBe("dismiss");
    expect(menu("v")).toBeUndefined();
});

test("a diagnostics report copies on Enter and goes back to the menu on Escape", () => {
    const report = (name: string) =>
        handleTuiDiagnosticsDialogKey({ name }, true, true, false);
    expect(report("return")).toBe("copy");
    expect(report("escape")).toBe("back");
    expect(report("up")).toBeUndefined();
    expect(report("down")).toBeUndefined();
});

test("inspect dialogs are one section, so Tab, ← → and Space are consumed", () => {
    for (const name of ["tab", "backtab", "left", "right", "space"]) {
        expect(handleTuiDiagnosticsDialogKey({ name })).toBe("consume");
        expect(handleTuiDiagnosticsDialogKey({ name, shift: true }, true, true, true))
            .toBe("consume");
        expect(handleTuiDiagnosticsDialogKey({ name }, true, true, false))
            .toBe("consume");
    }
});

test("the diagnostics menu lists Session and Vera and the report names its scope", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer, {
        scopeMenu: true,
    });
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    try {
        view.update({ text: "# Vera diagnostics\n## Build\nbody", scope: "vera", menu: true });
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Session");
        expect(frame).toContain("This conversation");
        expect(frame).toContain("The host");
        expect(frame).toContain("↑↓ choose · ⏎ open · esc close");
        expect(frame).not.toContain("Build");
        expect(frame).not.toContain("tab switch");

        view.update({ text: "# Vera diagnostics\n## Build\nbody", scope: "vera", menu: false });
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("Diagnostics › Vera");
        expect(frame).toContain("Build");
        expect(frame).not.toContain("This conversation");
        expect(frame).toContain("enter copies all · esc back");
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
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
    expect(color("░")).toEqual(parseColor(TUI_MUTED));
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

test("inspect health tones keep the word and decorate it", () => {
    const styled = styledInspectHealth([
        "  green    openrouter/glm-flash answered",
        "  yellow   only the last library model answered",
        "  red      no provider configured",
    ].join("\n"));
    const color = (text: string) =>
        styled.chunks.find((chunk) => chunk.text.toString() === text)?.fg;

    expect(color("green")).toEqual(parseColor(TUI_SUCCESS));
    expect(color("yellow")).toEqual(parseColor(TUI_NOTICE));
    expect(color("red")).toEqual(parseColor(TUI_DANGER));
});

test("a bare ! warning paints danger while a quoted one stays muted", async () => {
    const setup = await createTestRenderer({ width: 80, height: 40 });
    const view = createTuiDiagnosticsDialogView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update({
        text: [
            "# Context",
            "project  AGENTS.local.md  28 KB  7.0k",
            "",
            "!  Instructions are 7.0k tokens, over the 5.0k budget. Trim them.",
            "",
            "> !  AGENTS.local.md is 28 KB and rides every turn.",
        ].join("\n"),
    });

    try {
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        const danger = spans.find((span) => span.text.includes("over the 5.0k budget"));
        const quoted = spans.find((span) => span.text.includes("rides every turn"));
        expect(danger?.fg).toEqual(parseColor(TUI_DANGER));
        expect(danger?.text).toContain("!  Instructions are 7.0k tokens");
        expect(quoted).toBeDefined();
        expect(quoted?.fg).not.toEqual(parseColor(TUI_DANGER));
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});

test("styled danger keeps the ! marker in the text", () => {
    const styled = styledInspectDanger("!  Instructions are 7.0k tokens.");
    expect(styled.chunks.map((chunk) => chunk.text).join(""))
        .toBe("!  Instructions are 7.0k tokens.");
    expect(styled.chunks[0]?.fg).toEqual(parseColor(TUI_DANGER));
});

test("inspect reports use the terminal width with outer gutters", () => {
    expect(inspectDialogFrame(48)).toEqual({ left: 2, width: 44 });
    expect(inspectDialogFrame(80)).toEqual({ left: 2, width: 76 });
    expect(inspectDialogFrame(160)).toEqual({ left: 2, width: 156 });
    expect(inspectDialogFrame(20)).toEqual({ left: 2, width: 16 });
});

test("the inspect dialog renders markdown and wraps an overflowing value", async () => {
    const setup = await createTestRenderer({ width: 48, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer, {
        scopeMenu: true,
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
            "| File | `/Users/nash/.vera/runtime/sessions/session.jsonl` |",
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
        expect(first).toContain("/Users/nash/.vera/runtime/");
        expect(second).toContain("sessions/session.jsonl");
        expect(second!.indexOf("sessions/session.jsonl"))
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
    expect(view.box.left).toBe(2);
    expect(view.box.width).toBe(116);

    try {
        setup.resize(80, 30);
        view.update({ text: "# Report\nbody" });
        await setup.flush();
        expect(view.box.left).toBe(2);
        expect(view.box.width).toBe(76);
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

test("a Markdown source opens rendered and its source view numbers lines without copying them", async () => {
    const setup = await createTestRenderer({ width: 60, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer, { skipFirstLine: false });
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const source = { text: "# Crow rules\n\nSteal **only** shiny things.\n", markdown: true };
    const settle = async (): Promise<string> => {
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        return setup.captureCharFrame();
    };
    try {
        view.update({ text: "Source: /rules/crow.md", footerText: "Esc back", source });
        let frame = await settle();
        expect(frame).toContain("Steal only shiny things.");
        expect(frame).not.toContain("**only**");
        expect(frame).toContain("Esc back · s source");

        view.update({ text: "Source: /rules/crow.md", footerText: "Esc back", source, showSource: true });
        frame = await settle();
        const lines = frame.split("\n");
        const row = lines.findIndex((line) => line.includes("Steal **only** shiny things."));
        expect(lines[row]).toMatch(/\b3 +Steal/);
        expect(lines.some((line) => /\b1 +# Crow rules/.test(line))).toBe(true);
        expect(frame).toContain("Esc back · s rendered");

        const first = lines.findIndex((line) => line.includes("# Crow rules"));
        await setup.mockMouse.drag(lines[first]!.indexOf("# Crow"), first, lines[row]!.indexOf("things.") + 7, row);
        await settle();
        expect(setup.renderer.getSelection()?.getSelectedText()).toBe("# Crow rules\n\nSteal **only** shiny things.");
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});

test("rendered Markdown sources dim frontmatter and keep headings bright", async () => {
    expect(splitFrontmatter("---\npaths:\n  - \"src/crow/**\"\n---\n\n# Crow\n"))
        .toEqual({ frontmatter: "paths:\n  - \"src/crow/**\"", body: "# Crow\n" });
    expect(splitFrontmatter("# Crow\n\n---\n\nNo frontmatter.")).toEqual({ body: "# Crow\n\n---\n\nNo frontmatter." });
    const style = sourceMarkdownStyle();
    expect(style.getStyle("markup.heading.1")?.fg?.equals(parseColor(TUI_TEXT))).toBe(true);
    style.destroy();

    const setup = await createTestRenderer({ width: 60, height: 30 });
    const view = createTuiDiagnosticsDialogView(setup.renderer, { skipFirstLine: false });
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    try {
        view.update({
            text: "Scope: user\n\nSource: /rules/crow.md", footerText: "Esc back",
            source: { text: "---\npaths:\n  - \"src/crow/**\"\n---\n\n# Crow\n\nHoard buttons.\n", markdown: true },
        });
        await setup.flush();
        await Bun.sleep(50);
        await setup.flush();
        // Strip the scrollbar thumb so blank rows compare as blank.
        const lines = setup.captureCharFrame().split("\n").map((line) => line.replace(/[█▀▄]/g, " "));
        const source = lines.findIndex((line) => line.includes("Source: /rules/crow.md"));
        expect(lines.some((line) => line.includes("Scope: user"))).toBe(true);
        expect(lines[source + 2]).toContain("───");
        expect(lines[source + 3]!.trim()).toBe("");
        expect(lines[source + 4]).toContain("paths:");
        expect(lines[source + 5]).toContain("- \"src/crow/**\"");
        expect(lines.slice(source).some((line) => line.trim() === "---")).toBe(false);
        expect(lines.some((line) => line.trim() === "Crow")).toBe(true);
    } finally {
        view.box.destroyRecursively();
        setup.renderer.destroy();
    }
});
