import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { TUI_MUTED, TUI_TEXT } from "../../clients/tui/palette.ts";
import {
    createTuiWorkedDivider,
    tuiApprovalListLines,
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

test("an open divider lists each call with its reason under it", async () => {
    const { setup } = await drawDivider({ ...CLOSED, expanded: true });
    try {
        const frame = setup.captureCharFrame().split("\n");
        expect(frame[0]).toMatch(/^─ 2 auto-approved ─+$/);
        expect(frame[1]?.trim()).toBe("");
        expect(frame.slice(2, 8).map((line) => line.trimEnd())).toEqual([
            "  env -i DOUBLOON=one",
            "    ↳ Counting coins is harmless.",
            "",
            "  cat map.md",
            "    ↳ The parrot only reads the map.",
            "",
        ]);
        const spans = setup.captureSpans().lines;
        const call = spans[2]!.spans.find((span) => span.text.includes("DOUBLOON"))!;
        const reason = spans[3]!.spans.find((span) => span.text.includes("Counting"))!;
        expect(call.fg.toInts()).toEqual(RGBA.fromHex(TUI_TEXT).toInts());
        expect(reason.fg.toInts()).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
        expect(reason.attributes & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC);
    } finally {
        setup.renderer.destroy();
    }
});

test("long calls wrap under themselves and stop at two lines", () => {
    const call = "git -C /crow/nest/.worktrees/raid status --short --branch"
        + " && git -C /crow/nest/.worktrees/raid config user.name"
        + " && git -C /crow/nest merge-base main raid";
    expect(tuiApprovalListLines([{ tool: "bash", reason: "Only reads the log.", call }], 40)).toEqual([
        { kind: "call", text: "git -C /crow/nest/.worktrees/raid status" },
        { kind: "call", text: "  --short --branch && git -C /crow/nest…" },
        { kind: "reason", text: "  ↳ Only reads the log." },
    ]);
});

test("long reasons wrap under their own text", () => {
    const reason = "The captain asked for the raid, and this only counts the gulls on the mast.";
    expect(tuiApprovalListLines([{ tool: "bash", reason, call: "count gulls" }], 40)).toEqual([
        { kind: "call", text: "count gulls" },
        { kind: "reason", text: "  ↳ The captain asked for the raid, and" },
        { kind: "reason", text: "    this only counts the gulls on the" },
        { kind: "reason", text: "    mast." },
    ]);
});

test("a call with no rationale from the classifier shows no reason line", () => {
    expect(tuiApprovalListLines([
        { tool: "bash", reason: "The classifier returned an allow decision.", call: "cat map.md" },
        { tool: "read", reason: "" },
    ], 40)).toEqual([
        { kind: "call", text: "cat map.md" },
        { kind: "gap" },
        { kind: "call", text: "read" },
    ]);
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
