import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseColor } from "@opentui/core";

import {
    createTuiToolHeader,
    createTuiToolRow,
    updateTuiToolRow,
} from "../../clients/tui/tool-row.ts";
import { TUI_ACCENT, TUI_MUTED } from "../../clients/tui/state.ts";

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
