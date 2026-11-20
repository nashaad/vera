import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseColor } from "@opentui/core";

import {
    animateTuiToolHeader,
    createTuiToolHeader,
    createTuiToolRow,
    updateTuiToolHeader,
    updateTuiToolRow,
} from "../../clients/tui/tool-row.ts";
import {
    applyAgentUpdate,
    createTuiState,
    TUI_ACCENT,
    TUI_MUTED,
    TUI_TEXT,
} from "../../clients/tui/state.ts";

test("a compact tool preview stays to one row per summary", async () => {
    const setup = await createTestRenderer({ width: 28, height: 8 });
    setup.renderer.root.add(createTuiToolHeader(
        setup.renderer,
        "entry-preview",
        {
            kind: "tool_header",
            text: "+ Asked · 2 lines",
            detailLines: 2,
            detailPreview: [
                "  │ ask_user a much longer question that wraps",
                "  └ answer",
            ].join("\n"),
        },
        0,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        const first = rows.findIndex((row) => row.includes("│ ask_user"));
        expect(first).toBeGreaterThan(-1);
        expect(rows[first]).toContain("│ ask_user");
        expect(rows[first + 1]).toContain("└ answer");
        expect(rows[first + 2]?.trim()).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("a short result keeps its tree row under the header", async () => {
    const setup = await createTestRenderer({ width: 52, height: 4 });
    setup.renderer.root.add(createTuiToolHeader(
        setup.renderer,
        "entry-inline-preview",
        {
            kind: "tool_header",
            text: "+ Ran",
            command: "test -f config.json",
            detailLines: 2,
            detailPreview: "  └ config-ok",
            hint: true,
        },
        0,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows[0]).toContain("  Ran  test -f");
        expect(rows[0]).toContain("Ctrl+T details");
        expect(rows[0]).not.toContain("└");
        expect(rows[1]).toContain("└ config-ok");
        expect(rows[2]?.trim()).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("a failed edit updates the rendered heading and keeps its result", async () => {
    const setup = await createTestRenderer({ width: 60, height: 6 });
    let state = applyAgentUpdate(createTuiState(), {
        type: "tool_started",
        tool: "edit",
        args: { path: "README.md" },
        seq: 1,
    });
    const initial = state.entries.find((entry) => entry.kind === "tool_header");
    if (initial?.kind !== "tool_header") throw new Error("Missing tool header");
    const header = createTuiToolHeader(setup.renderer, "failed-edit", initial, 0);
    setup.renderer.root.add(header);

    try {
        await setup.flush();
        expect(setup.captureCharFrame().split("\n")[0]).toContain("Editing");
        state = applyAgentUpdate(state, {
            type: "tool_finished",
            tool: "edit",
            output: "Read README.md first.",
            isError: true,
            seq: 2,
        });
        const completed = state.entries.find((entry) => entry.kind === "tool_header");
        if (completed?.kind !== "tool_header") throw new Error("Missing tool header");
        updateTuiToolHeader(header, completed);
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows[0]).toContain("  Failed  Edit README.md");
        expect(rows[1]).toContain("  └ Read README.md first.");
        expect(rows[2]?.trim()).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});

test("an extension failure renders with the built-in failure colors and spacing", async () => {
    const colors = [];
    for (const tool of ["edit", "view_image"]) {
        const setup = await createTestRenderer({ width: 60, height: 6 });
        let state = applyAgentUpdate(createTuiState(), {
            type: "tool_started", tool, args: { path: "missing.png" }, seq: 1,
        });
        state = applyAgentUpdate(state, {
            type: "tool_finished", tool, output: "Missing image file", isError: true, seq: 2,
        });
        const header = state.entries.find((entry) => entry.kind === "tool_header");
        if (header?.kind !== "tool_header") throw new Error("Missing tool header");
        setup.renderer.root.add(createTuiToolHeader(setup.renderer, `failed-${tool}`, header, 0));
        try {
            await setup.flush();
            const rows = setup.captureCharFrame().split("\n");
            expect(rows[0]).toContain(tool === "edit" ? "  Failed  Edit missing.png" : "  Failed  view_image missing.png");
            expect(rows[1]).toContain("  └ Missing image file");
            expect(rows[2]?.trim()).toBe("");
            const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
            const heading = spans.find((span) => span.text.includes("Failed"));
            const preview = spans.find((span) => span.text.includes("Missing image file"));
            if (heading === undefined || preview === undefined) throw new Error("Missing failure spans");
            colors.push({ heading: heading.fg, preview: preview.fg });
        } finally {
            setup.renderer.destroy();
        }
    }
    expect(colors[1]!.heading.equals(colors[0]!.heading)).toBe(true);
    expect(colors[1]!.preview.equals(colors[0]!.preview)).toBe(true);
});

test("exit tags render as neutral text on the compact heading and call row", async () => {
    const setup = await createTestRenderer({ width: 56, height: 6 });
    setup.renderer.root.add(createTuiToolHeader(
        setup.renderer,
        "exit-tag-heading",
        { kind: "tool_header", header: "Ran", text: "+ Ran · exit 7" },
        0,
    ));
    setup.renderer.root.add(createTuiToolRow(
        setup.renderer,
        "exit-tag-row",
        { kind: "tool", header: "Ran", prefix: "  └ ", text: "false · exit 7" },
        0,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows[0]).toContain("  Ran · exit 7");
        expect(rows[1]).toContain("  └ false · exit 7");
        expect(rows[2]?.trim()).toBe("");
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        const heading = spans.find((span) => span.text.includes("Ran · exit 7"));
        const exitTag = spans.find((span) => span.text.includes("false"));
        if (heading === undefined || exitTag === undefined) throw new Error("Missing exit tag spans");
        expect(heading.fg.equals(parseColor(TUI_TEXT))).toBe(true);
        expect(exitTag.fg.equals(parseColor(TUI_MUTED))).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("a wrapped tool row hangs under its own text", async () => {
    const setup = await createTestRenderer({ width: 20, height: 8 });
    setup.renderer.root.add(createTuiToolRow(
        setup.renderer,
        "entry-0",
        {
            kind: "tool",
            header: "Ran",
            prefix: "  └ ",
            text: "grep alpha bravo charlie",
        },
        0,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows[0]).toContain("└ grep alpha");
        // The wrap lands under the text, not back at the left edge.
        expect(rows[1]?.startsWith("    ")).toBe(true);
        expect(rows[1]?.trim()).toBe("bravo charlie");
    } finally {
        setup.renderer.destroy();
    }
});

test("a tool row highlights its semantic action", async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const row = createTuiToolRow(
        setup.renderer,
        "entry-semantic-action",
        {
            kind: "tool",
            header: "Explored",
            prefix: "  └ ",
            text: "Read state.ts",
        },
        0,
    );
    setup.renderer.root.add(row);

    try {
        await setup.flush();
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        const spanFor = (value: string) => spans.find((span) =>
            span.text === value
        );
        expect(spanFor("Read")?.fg.equals(parseColor(TUI_ACCENT))).toBe(true);
        expect(spanFor(" state.ts")?.fg.equals(parseColor(TUI_MUTED)))
            .toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("a repeated call raises the count on the row already on screen", async () => {
    const setup = await createTestRenderer({ width: 20, height: 8 });
    const entry = {
        kind: "tool" as const,
        header: "Ran",
        prefix: "  └ ",
        text: "pwd",
    };
    const row = createTuiToolRow(setup.renderer, "entry-0", entry, 0);
    setup.renderer.root.add(row);

    try {
        await setup.flush();
        updateTuiToolRow(row, { ...entry, repeat: 2 });
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows[0]).toContain("└ pwd ×2");
    } finally {
        setup.renderer.destroy();
    }
});

test("a finished command draws a vertical connector through wrapped lines", async () => {
    const setup = await createTestRenderer({ width: 20, height: 8 });
    setup.renderer.root.add(createTuiToolRow(
        setup.renderer,
        "entry-connected",
        {
            kind: "tool",
            header: "Ran",
            prefix: "  │ ",
            text: "grep alpha bravo charlie",
        },
        0,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows[0]).toContain("│ grep alpha");
        expect(rows[1]).toContain("│ bravo charlie");
    } finally {
        setup.renderer.destroy();
    }
});

test("a running header shimmers and a finished one stays plain", async () => {
    const setup = await createTestRenderer({ width: 40, height: 4 });
    const header = createTuiToolHeader(
        setup.renderer,
        "entry-live-header",
        { kind: "tool_header", header: "Running", active: true, text: "Running" },
        0,
    );
    setup.renderer.root.add(header);
    const firstLetterColor = async () => {
        await setup.flush();
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        return spans.find((span) => span.text.startsWith("R"))?.fg;
    };

    try {
        expect((await firstLetterColor())?.equals(parseColor(TUI_TEXT))).toBe(true);
        animateTuiToolHeader(header, 10);
        const dimmed = await firstLetterColor();
        expect(dimmed?.equals(parseColor(TUI_TEXT))).toBe(false);
        expect(dimmed?.equals(parseColor(TUI_ACCENT))).toBe(false);

        updateTuiToolHeader(header, { kind: "tool_header", header: "Ran", text: "Ran" });
        animateTuiToolHeader(header, 10);
        expect((await firstLetterColor())?.equals(parseColor(TUI_TEXT))).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});
