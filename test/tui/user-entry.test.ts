import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiUserEntry } from "../../clients/tui/user-entry.ts";

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

test("a later user turn starts with a pane-width separator", async () => {
    const setup = await createTestRenderer({ width: 32, height: 8 });
    setup.renderer.root.add(createTuiUserEntry(
        setup.renderer,
        "entry-1",
        { kind: "user", text: "next turn" },
        0,
        true,
    ));

    try {
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        expect(rows.some((row) => row.includes("─".repeat(30)))).toBe(true);
        expect(rows.some((row) => row.includes("next turn"))).toBe(true);
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
