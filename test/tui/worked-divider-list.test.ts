import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { TUI_MUTED, TUI_TEXT } from "../../clients/tui/palette.ts";
import {
    createTuiWorkedDivider,
    updateTuiWorkedDivider,
    type TuiWorkedDividerView,
} from "../../clients/tui/worked-divider.ts";

const CLOSED: TuiWorkedDividerView = {
    text: "2 auto-approved",
    approvals: [
        { tool: "bash", reason: "Counting coins is harmless.", call: "env -i DOUBLOON=one" },
        { tool: "bash", reason: "The parrot only reads the map.", call: "cat map.md" },
    ],
    expanded: false,
};

async function drawDivider(view: TuiWorkedDividerView) {
    const setup = await createTestRenderer({ width: 70, height: 8 });
    const toggles: number[] = [];
    const node = createTuiWorkedDivider(setup.renderer, "entry-worked", view, () => {
        toggles.push(toggles.length);
    });
    setup.renderer.root.add(node);
    await setup.flush();
    return { setup, node, toggles };
}

test("a closed divider is one row", async () => {
    const { setup } = await drawDivider(CLOSED);
    try {
        const frame = setup.captureCharFrame().split("\n");
        expect(frame[0]).toMatch(/^─ 2 auto-approved ─+$/);
        expect(frame[1]?.trim()).toBe("");
        expect(frame.join("\n")).not.toContain("DOUBLOON");
    } finally {
        setup.renderer.destroy();
    }
});

test("an open divider lists each call under a blank line with aligned reasons", async () => {
    const { setup } = await drawDivider({ ...CLOSED, expanded: true });
    try {
        const frame = setup.captureCharFrame().split("\n");
        expect(frame[0]).toMatch(/^─ 2 auto-approved ─+$/);
        expect(frame[1]?.trim()).toBe("");
        expect(frame[2]).toBe("  env -i DOUBLOON=one   Counting coins is harmless.".padEnd(70));
        expect(frame[3]).toBe("  cat map.md            The parrot only reads the map.".padEnd(70));
        expect(frame[4]?.trim()).toBe("");
        const spans = setup.captureSpans().lines;
        const call = spans[2]!.spans.find((span) => span.text.includes("DOUBLOON"))!;
        const reason = spans[2]!.spans.find((span) => span.text.includes("Counting"))!;
        expect(call.fg.toInts()).toEqual(RGBA.fromHex(TUI_TEXT).toInts());
        expect(reason.fg.toInts()).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
    } finally {
        setup.renderer.destroy();
    }
});

test("clicking the divider row asks to toggle, and an update shows the list", async () => {
    const { setup, node, toggles } = await drawDivider(CLOSED);
    try {
        await setup.mockMouse.click(4, 0);
        expect(toggles).toHaveLength(1);
        await setup.mockMouse.click(4, 1);
        expect(toggles).toHaveLength(1);
        updateTuiWorkedDivider(node, { ...CLOSED, expanded: true });
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("cat map.md");
    } finally {
        setup.renderer.destroy();
    }
});
