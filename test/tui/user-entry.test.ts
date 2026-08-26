import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiUserEntry,
    repaintTuiUserEntry,
} from "../../clients/tui/user-entry.ts";
import { applyTuiTheme } from "../../clients/tui/state.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("a user message fills the width of the transcript", async () => {
    const setup = await createTestRenderer({ width: 24, height: 8 });
    setup.renderer.root.add(createTuiUserEntry(
        setup.renderer,
        "entry-0",
        { kind: "user", text: "check the layout" },
        0,
    ));

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("check the layout");
        // The band is the width of the terminal, so the row the message sits on
        // runs edge to edge rather than stopping where the text does.
        const row = frame.split("\n").find((line) => line.includes("check"));
        expect(row?.length).toBe(24);
    } finally {
        setup.renderer.destroy();
    }
});

test("attachments show as file chips under the message", async () => {
    const setup = await createTestRenderer({ width: 48, height: 8 });
    setup.renderer.root.add(createTuiUserEntry(
        setup.renderer,
        "entry-0",
        {
            kind: "user",
            text: "look",
            attachments: ["shot.png", "attached image"],
        },
        0,
    ));

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("look");
        expect(frame).toContain("File  shot.png");
        expect(frame).toContain("File  attached image");
    } finally {
        setup.renderer.destroy();
    }
});

test("an attachment-only prompt has no blank row above its file", async () => {
    const setup = await createTestRenderer({ width: 48, height: 8 });
    setup.renderer.root.add(createTuiUserEntry(
        setup.renderer,
        "entry-0",
        {
            kind: "user",
            text: "",
            attachments: ["shot.png"],
        },
        0,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        const caretRow = rows.findIndex((row) => row.includes("›"));
        const fileRow = rows.findIndex((row) => row.includes("File  shot.png"));
        expect(fileRow).toBe(caretRow + 1);
    } finally {
        setup.renderer.destroy();
    }
});

test("the band leaves out what an extension injected", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const note = "<system-note>\nsomeone joined\n</system-note>\n\n";
    setup.renderer.root.add(createTuiUserEntry(
        setup.renderer,
        "entry-0",
        { kind: "user", text: `${note}hi @all`, dimmedPrefix: note.length },
        0,
    ));

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("hi @all");
        // The model was sent the note; the band is what the user said.
        expect(frame).not.toContain("system-note");
        expect(frame).not.toContain("joined");
    } finally {
        setup.renderer.destroy();
    }
});

test("an existing user band repaints without replacing its node", async () => {
    const setup = await createTestRenderer({ width: 48, height: 8 });
    const node = createTuiUserEntry(
        setup.renderer,
        "entry-theme",
        { kind: "user", text: "look", attachments: ["shot.png"] },
        0,
    );
    const nextTheme = {
        ...VERA_TUI_THEME,
        accent: "#123456",
        text: "#234567",
        muted: "#345678",
        element: "#456789",
    };

    try {
        applyTuiTheme(nextTheme);
        repaintTuiUserEntry(node);
        expect(node.backgroundColor.toInts()).toEqual(
            RGBA.fromHex(nextTheme.element).toInts(),
        );
        const label = node.findDescendantById(
            "entry-theme-chip-0-label",
        ) as TextRenderable;
        const name = node.findDescendantById(
            "entry-theme-chip-0-name",
        ) as TextRenderable;
        expect(label.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.accent).toInts(),
        );
        expect(name.fg.toInts()).toEqual(
            RGBA.fromHex(nextTheme.muted).toInts(),
        );
    } finally {
        applyTuiTheme(VERA_TUI_THEME);
        setup.renderer.destroy();
    }
});
