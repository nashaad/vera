import { expect, test } from "bun:test";
import {
    BoxRenderable,
    RGBA,
    SyntaxStyle,
    TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    clampSidebarWidth,
    MIN_SPLIT_WIDTH,
    createTuiSidebar,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MIN_TRANSCRIPT_WIDTH,
} from "../../clients/tui/sidebar.ts";
import { isTranscriptSelection } from "../../clients/tui/selection.ts";

test("the divider cannot be dragged past either side's floor", () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 120)).toBe(
        DEFAULT_SIDEBAR_WIDTH,
    );
    expect(clampSidebarWidth(2, 120)).toBe(MIN_SIDEBAR_WIDTH);
    // 120 - 30 transcript - 3 divider.
    expect(clampSidebarWidth(500, 120)).toBe(89);
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

async function openSidebar(
    width = 120,
    height = 12,
    onPanelClick?: () => void,
    onLayoutChanged?: () => void,
    onPanelRelease?: () => void,
    transcriptText?: string,
    onHeaderClick?: () => void,
    onMainHeaderClick?: () => void,
) {
    const setup = await createTestRenderer({ width, height });
    const transcript = new BoxRenderable(setup.renderer, {
        id: "transcript",
        flexGrow: 1,
        height: "100%",
    });
    if (transcriptText !== undefined) {
        transcript.add(new TextRenderable(setup.renderer, {
            content: transcriptText,
            height: 1,
        }));
    }
    const sidebar = createTuiSidebar({
        renderer: setup.renderer,
        transcript,
        theme: {
            handle: "#333333",
            handleActive: "#666666",
            muted: "#888888",
            text: "#ffffff",
            focus: "#22c55e",
            inactive: "#4b5563",
        },
        syntaxStyle: STYLE,
        ...(onPanelClick === undefined ? {} : { onPanelClick }),
        ...(onLayoutChanged === undefined ? {} : { onLayoutChanged }),
        ...(onPanelRelease === undefined ? {} : { onPanelRelease }),
        ...(onHeaderClick === undefined ? {} : { onHeaderClick }),
        ...(onMainHeaderClick === undefined ? {} : { onMainHeaderClick }),
    });
    setup.renderer.root.add(sidebar.body);
    sidebar.open();
    return { setup, sidebar, transcript };
}

test("a drag that jumps clear of the divider still resizes the sidebar", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        // The divider sits between the transcript and the panel.
        const dividerX = 120 - sidebar.width() - 1;
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
            handle: "#333333",
            handleActive: "#666666",
            muted: "#888888",
            text: "#ffffff",
            focus: "#22c55e",
            inactive: "#4b5563",
        },
        syntaxStyle: STYLE,
        onWidthChanged: (columns) => widths.push(columns),
    });
    setup.renderer.root.add(sidebar.body);
    sidebar.open();
    try {
        const dividerX = 120 - sidebar.width() - 1;
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

test("replacing sidebar blocks publishes one completed layout", async () => {
    let layouts = 0;
    const { setup, sidebar } = await openSidebar(
        120,
        12,
        undefined,
        () => layouts++,
    );
    try {
        sidebar.append("old", "old answer");
        const retainedNode = sidebar.blocks()[0]!.node;
        const before = layouts;
        sidebar.replace([
            { label: "you", text: "new question" },
            { label: "agent", text: "new answer" },
        ]);
        expect(layouts - before).toBe(1);
        expect(sidebar.blocks()[0]!.node).toBe(retainedNode);
        await setup.flush();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("old answer");
        expect(frame).toContain("new question");
        expect(frame).toContain("new answer");
    } finally {
        setup.renderer.destroy();
    }
});

test("focus rail follows the active pane symmetrically", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        expect(sidebar.isFocused()).toBe(false);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("━".repeat(75));
        sidebar.setFocused(true);
        await setup.flush();
        expect(sidebar.isFocused()).toBe(true);
        expect(setup.captureCharFrame()).toContain(
            "━".repeat(DEFAULT_SIDEBAR_WIDTH),
        );
        sidebar.setFocused(false);
        await setup.flush();
        expect(sidebar.isFocused()).toBe(false);
        expect(setup.captureCharFrame()).toContain("━".repeat(75));
        sidebar.setFocused(true);
        await setup.flush();
        expect(sidebar.isFocused()).toBe(true);
        expect(setup.captureCharFrame()).toContain(
            "━".repeat(DEFAULT_SIDEBAR_WIDTH),
        );
    } finally {
        setup.renderer.destroy();
    }
});

test("focus rail colors repaint from the active theme", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        sidebar.setFocused(true);
        sidebar.setTheme({
            handle: "#333333",
            handleActive: "#666666",
            muted: "#888888",
            text: "#ffffff",
            focus: "#123456",
            inactive: "#654321",
        }, STYLE);

        const mainRail = sidebar.body.findDescendantById(
            "main-focus-rail",
        ) as TextRenderable;
        const sidebarRail = sidebar.body.findDescendantById(
            "sidebar-focus-rail",
        ) as TextRenderable;
        expect(mainRail.fg.toInts()).toEqual(RGBA.fromHex("#654321").toInts());
        expect(sidebarRail.fg.toInts()).toEqual(
            RGBA.fromHex("#123456").toInts(),
        );
    } finally {
        setup.renderer.destroy();
    }
});

test("focus rails sit above transcripts and identity rows stay below", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        sidebar.setMainHeader("Vera · ask");
        sidebar.setHeader("sidekick · readonly");
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const mainHeader = lines.findIndex((line) =>
            line.includes("Vera · ask")
        );
        const sideHeader = lines.findIndex((line) =>
            line.includes("sidekick · readonly")
        );
        expect(mainHeader).toBeGreaterThanOrEqual(0);
        expect(sideHeader).toBe(mainHeader);
        const focusRail = lines.findIndex((line) => line.includes("━"));
        expect(focusRail).toBeGreaterThanOrEqual(0);
        expect(focusRail).toBeLessThan(mainHeader);
    } finally {
        setup.renderer.destroy();
    }
});

test("pane headers leave a quiet row before the transcript", async () => {
    const { setup, sidebar } = await openSidebar(
        120,
        12,
        undefined,
        undefined,
        undefined,
        "first transcript line",
    );
    try {
        sidebar.setMainHeader("Session: Planning");
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const header = lines.findIndex((line) =>
            line.includes("Session: Planning")
        );
        const transcript = lines.findIndex((line) =>
            line.includes("first transcript line")
        );

        expect(header).toBeGreaterThanOrEqual(0);
        expect(transcript).toBe(header + 2);
    } finally {
        setup.renderer.destroy();
    }
});

test("visible pane headers toggle through their own mouse targets", async () => {
    let sideClicks = 0;
    let mainClicks = 0;
    const { setup, sidebar } = await openSidebar(
        120,
        12,
        undefined,
        undefined,
        undefined,
        undefined,
        () => sideClicks++,
        () => mainClicks++,
    );
    try {
        sidebar.setMainHeader("Session: Planning");
        sidebar.setHeader("sidekick · readonly");
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n");
        const mainHeader = lines.findIndex((line) =>
            line.includes("Session: Planning")
        );
        const sideHeader = lines.findIndex((line) =>
            line.includes("sidekick · readonly")
        );
        expect(mainHeader).toBeGreaterThanOrEqual(0);
        expect(sideHeader).toBe(mainHeader);

        await setup.mockMouse.click(8, mainHeader);
        await setup.mockMouse.click(120 - sidebar.width() + 8, sideHeader);
        expect(mainClicks).toBe(1);
        expect(sideClicks).toBe(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("an attached agent identity updates in place", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        sidebar.setHeader("agent-b · readonly");
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("agent-b · readonly");
        sidebar.setHeader("agent-b · ask");
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("agent-b · ask");
        expect(frame).not.toContain("agent-b · readonly");
    } finally {
        setup.renderer.destroy();
    }
});

test("the whole sidebar column, including its focus rail, owns clicks", async () => {
    let clicks = 0;
    const { setup, sidebar } = await openSidebar(120, 12, () => clicks++);
    try {
        await setup.flush();
        await setup.mockMouse.click(80, 4);
        expect(clicks).toBe(1);

        sidebar.setFocused(true);
        await setup.flush();
        await setup.mockMouse.click(80, 11);
        expect(clicks).toBe(2);
    } finally {
        setup.renderer.destroy();
    }
});

test("a sidebar drag still publishes its release", async () => {
    let releases = 0;
    const { setup } = await openSidebar(
        120,
        12,
        undefined,
        undefined,
        () => releases++,
    );
    try {
        await setup.flush();
        await setup.mockMouse.pressDown(80, 4);
        await setup.mockMouse.emitMouseEvent("drag", 85, 4);
        await setup.mockMouse.release(85, 4);
        expect(releases).toBeGreaterThan(0);
    } finally {
        setup.renderer.destroy();
    }
});

test("a terminal too narrow to split puts the sidebar away until it is wide again", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        expect(sidebar.isShown()).toBe(true);
        setup.resize(MIN_SPLIT_WIDTH - 1, 12);
        sidebar.refit();
        await setup.flush();
        // Still open, only out of the way.
        expect(sidebar.isOpen()).toBe(true);
        expect(sidebar.isShown()).toBe(false);

        setup.resize(MIN_SPLIT_WIDTH, 12);
        sidebar.refit();
        await setup.flush();
        expect(sidebar.isShown()).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("cycles between split, sidebar-only, main-only, and split", async () => {
    const { setup, sidebar } = await openSidebar();
    try {
        expect(sidebar.layout()).toBe("split");
        sidebar.cycleLayout();
        await setup.flush();
        expect(sidebar.isOpen()).toBe(true);
        expect(sidebar.layout()).toBe("sidebar");
        expect(sidebar.isShown()).toBe(true);
        expect(sidebar.isFocused()).toBe(true);

        sidebar.cycleLayout();
        await setup.flush();
        expect(sidebar.layout()).toBe("main");
        expect(sidebar.isShown()).toBe(false);
        expect(sidebar.isFocused()).toBe(false);

        sidebar.cycleLayout();
        await setup.flush();
        expect(sidebar.layout()).toBe("split");
        expect(sidebar.isShown()).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

for (const direction of ["downward", "upward"] as const) {
    test(`a ${direction} selection across the main pane header copies without clicking it`, async () => {
        let headerClicks = 0;
        const { setup, sidebar, transcript } = await openSidebar(
            120,
            12,
            undefined,
            undefined,
            undefined,
            "Please COPY THIS TEXT from the transcript.",
            undefined,
            () => { headerClicks += 1; },
        );
        try {
            sidebar.setMainHeader("Vera · auto");
            await setup.flush();
            const lines = setup.captureCharFrame().split("\n");
            const headerRow = lines.findIndex((line) => line.includes("Vera · auto"));
            const textRow = lines.findIndex((line) => line.includes("Please COPY THIS TEXT"));
            expect(headerRow).toBeGreaterThanOrEqual(0);
            const start = { x: lines[headerRow]!.indexOf("Vera"), y: headerRow };
            const end = { x: lines[textRow]!.indexOf("transcript.") + "transcript.".length, y: textRow };
            const [from, to] = direction === "downward" ? [start, end] : [end, start];
            await setup.mockMouse.drag(from.x, from.y, to.x, to.y);
            await setup.flush();
            const selection = setup.renderer.getSelection();
            expect(selection?.getSelectedText()).toContain("Please COPY THIS TEXT from the transcript.");
            expect(isTranscriptSelection(selection!, [...sidebar.headers(), ...transcript.getChildren()])).toBe(true);
            expect(headerClicks).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });
}
