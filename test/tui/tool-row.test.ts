import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiToolRow, updateTuiToolRow } from "../../clients/tui/tool-row.ts";

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
