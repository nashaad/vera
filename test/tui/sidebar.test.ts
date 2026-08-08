import { expect, test } from "bun:test";
import { BoxRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    clampSidebarWidth,
    createTuiSidebar,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MIN_TRANSCRIPT_WIDTH,
} from "../../clients/tui/sidebar.ts";

test("the divider cannot be dragged past either side's floor", () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 120)).toBe(
        DEFAULT_SIDEBAR_WIDTH,
    );
    expect(clampSidebarWidth(2, 120)).toBe(MIN_SIDEBAR_WIDTH);
    // 120 - 30 transcript - 3 divider.
    expect(clampSidebarWidth(500, 120)).toBe(87);
    expect(clampSidebarWidth(40.4, 120)).toBe(40);
});

test("a terminal too narrow to split leaves the sidebar its floor", () => {
    const narrow = MIN_SIDEBAR_WIDTH + MIN_TRANSCRIPT_WIDTH - 5;
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, narrow)).toBe(
        MIN_SIDEBAR_WIDTH,
    );
});

const STYLE = SyntaxStyle.fromStyles({
    default: { fg: "#ffffff" },
    "markup.strong": { bold: true },
    conceal: { fg: "#888888" },
});

async function openSidebar(width = 120, height = 12) {
    const setup = await createTestRenderer({ width, height });
    const transcript = new BoxRenderable(setup.renderer, {
        id: "transcript",
        flexGrow: 1,
        height: "100%",
    });
    const sidebar = createTuiSidebar({
        renderer: setup.renderer,
        transcript,
        theme: {
            background: "#000000",
            border: "#444444",
            muted: "#888888",
            text: "#ffffff",
        },
        syntaxStyle: STYLE,
    });
    setup.renderer.root.add(sidebar.body);
    sidebar.open("Seats");
    return { setup, sidebar };
}

test("a drag that jumps clear of the divider still resizes the sidebar", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        // The divider sits between the transcript and the panel.
        const dividerX = 120 - sidebar.width() - 2;
        await setup.flush();
        await setup.mockMouse.pressDown(dividerX, 5);
        // One report, landing well inside the transcript: what a fast drag or
        // a coarse terminal actually sends.
        await setup.mockMouse.emitMouseEvent("drag", 40, 5);
        await setup.flush();
        expect(sidebar.width()).toBe(120 - 40 - 1);
        await setup.mockMouse.release(40, 5);
    } finally {
        setup.renderer.destroy();
    }
});

test("a settled drag reports the width once", async () => {
    const setup = await createTestRenderer({ width: 120, height: 12 });
    const widths: number[] = [];
    const transcript = new BoxRenderable(setup.renderer, {
        id: "transcript",
        flexGrow: 1,
        height: "100%",
    });
    const sidebar = createTuiSidebar({
        renderer: setup.renderer,
        transcript,
        theme: {
            background: "#000000",
            border: "#444444",
            muted: "#888888",
            text: "#ffffff",
        },
        syntaxStyle: STYLE,
        onWidthChanged: (columns) => widths.push(columns),
    });
    setup.renderer.root.add(sidebar.body);
    sidebar.open("Seats");
    try {
        const dividerX = 120 - sidebar.width() - 2;
        await setup.flush();
        await setup.mockMouse.pressDown(dividerX, 5);
        await setup.mockMouse.emitMouseEvent("drag", 60, 5);
        await setup.mockMouse.release(60, 5);
        await setup.flush();
        expect(widths).toEqual([120 - 60 - 1]);
        // The button is up: pointer motion is no longer a resize.
        await setup.mockMouse.emitMouseEvent("drag", 90, 5);
        await setup.flush();
        expect(sidebar.width()).toBe(120 - 60 - 1);
    } finally {
        setup.renderer.destroy();
    }
});

test("a bracketed label is shown, not parsed as markdown", async () => {
    const { setup, sidebar } = await openSidebar(120, 12);
    try {
        sidebar.append("[m1] (gpt-5.5)", "answer");
        await setup.flush();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("[m1] (gpt-5.5)");
    } finally {
        setup.renderer.destroy();
    }
});
