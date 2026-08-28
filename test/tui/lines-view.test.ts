import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
    parseColor,
    type BoxRenderable,
    type StyledText,
    type TextRenderable,
} from "@opentui/core";

import {
    createTuiLinesView,
    type LinesViewState,
} from "../../clients/tui/lines-view.ts";
import { TUI_ACCENT } from "../../clients/tui/state.ts";

const STATE: LinesViewState = {
    title: "VERA",
    titleLeading: { text: "VERA", tone: "accent" },
    hint: "",
    lines: [
        {
            text: "✓ this one",
            leading: { text: "✓", tone: "positive" },
            rowId: "a",
            selected: true,
        },
        { text: "· that one", rowId: "b" },
    ],
    cursorLine: 0,
    footer: "Focus  ctrl+e",
};

/** Every row the surface drew on the accent ground. */
function accentRows(box: BoxRenderable): BoxRenderable[] {
    const accent = parseColor(TUI_ACCENT).toString();
    return box.getChildren().filter((child): child is BoxRenderable =>
        (child as BoxRenderable).backgroundColor?.toString() === accent
    );
}

test("a rail draws its selection bar only while it holds the keyboard", async () => {
    const { renderer } = await createTestRenderer({ width: 100, height: 34 });
    try {
        const view = createTuiLinesView(renderer, "rail", {
            railDivider: true,
            railPadding: 2,
        });
        view.setRail(28);

        view.update({ ...STATE, focused: true });
        expect(accentRows(view.box)).toHaveLength(1);

        // Nothing about the rows changed, so the session-state glyph remains.
        // Only the selection bar behind it is gone.
        view.update({ ...STATE, dimmed: true });
        expect(accentRows(view.box)).toHaveLength(0);

        // A centred card owns the keyboard whenever it is up, and none of them
        // set `focused`. Suppressing on that alone would strip every picker.
        view.setRail(undefined);
        view.update(STATE);
        expect(accentRows(view.box)).toHaveLength(1);
    } finally {
        renderer.destroy();
    }
});

test("rail header actions are visible text and activate by id", async () => {
    const setup = await createTestRenderer({ width: 100, height: 34 });
    const { renderer } = setup;
    try {
        const activated: string[] = [];
        const view = createTuiLinesView(renderer, "rail-actions", {
            railDivider: true,
            railPadding: 2,
        });
        view.pointer = { activate: (id) => activated.push(id) };
        view.setRail(28);
        view.update({
            ...STATE,
            headerActions: [
                { id: "all", text: "≡" },
                { id: "new", text: "+" },
            ],
        });
        renderer.root.add(view.surface);
        view.surface.visible = true;
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain("VERA");
        expect(frame).toContain("≡");
        expect(frame).toContain("+");

        const line = frame.split("\n").findIndex((row) => row.includes("≡"));
        const column = frame.split("\n")[line]!.indexOf("≡");
        await setup.mockMouse.click(column, line);
        await setup.flush();
        expect(activated).toEqual(["all"]);
    } finally {
        renderer.destroy();
    }
});

test("a focused rail accents only its title wordmark", async () => {
    const { renderer } = await createTestRenderer({ width: 100, height: 34 });
    try {
        const view = createTuiLinesView(renderer, "rail-title", {
            railDivider: true,
            railPadding: 2,
        });
        view.setRail(28);
        view.update({ ...STATE, title: "VERA · 2", focused: true });

        const header = view.box.getChildren()[0] as BoxRenderable;
        const title = header.getChildren()[0] as TextRenderable;
        const chunks = (title.content as StyledText).chunks;
        expect(chunks[0]?.text.toString()).toBe("VERA");
        expect(chunks[0]?.fg).toEqual(parseColor(TUI_ACCENT));
        expect(chunks[1]?.text.toString()).toBe(" · 2");

        view.update({ ...STATE, title: "VERA · 2", dimmed: true });
        const dimmedHeader = view.box.getChildren()[0] as BoxRenderable;
        const dimmedTitle = dimmedHeader.getChildren()[0] as TextRenderable;
        const dimmedChunks = (dimmedTitle.content as StyledText).chunks;
        expect(dimmedChunks).toHaveLength(1);
        expect(dimmedChunks[0]?.text.toString()).toBe("VERA · 2");
    } finally {
        renderer.destroy();
    }
});
