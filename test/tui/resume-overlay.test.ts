import { expect, test } from "bun:test";

import {
    JSONL_VIEW_SCROLL_IDS,
    jsonlViewKeyAction,
    RESUME_OVERLAY_HINT,
    RESUME_OVERLAY_LABEL,
    RESUME_OVERLAY_TEXT,
} from "../../clients/tui/resume-overlay.ts";

test("the overlay names resume in brackets and enter as the key", () => {
    expect(RESUME_OVERLAY_LABEL).toBe("[resume]");
    expect(RESUME_OVERLAY_HINT).toBe("enter");
    expect(RESUME_OVERLAY_TEXT).toBe("[resume] · enter");
});

test("enter resumes when the file view owns the keyboard", () => {
    expect(jsonlViewKeyAction({ name: "return" }, { sidebarFocused: false }))
        .toBe("resume");
    expect(jsonlViewKeyAction({ name: "enter" }, { sidebarFocused: false }))
        .toBe("resume");
});

test("a modified enter does not resume", () => {
    expect(jsonlViewKeyAction(
        { name: "return", ctrl: true },
        { sidebarFocused: false },
    )).toBe("block");
});

test("transcript scroll chords still move the file", () => {
    for (const binding of JSONL_VIEW_SCROLL_IDS) {
        expect(jsonlViewKeyAction(
            { name: "up", ctrl: true },
            { conversationBinding: binding, sidebarFocused: false },
        )).toBe("scroll");
    }
});

test("scroll wins even while the agent sidebar is focused", () => {
    expect(jsonlViewKeyAction(
        { name: "up", ctrl: true },
        {
            conversationBinding: "scroll_line_up",
            sidebarFocused: true,
        },
    )).toBe("scroll");
});

test("the rail can still take focus so you can leave without resuming", () => {
    expect(jsonlViewKeyAction(
        { name: "e", ctrl: true },
        {
            globalBinding: "toggle_workspace_sidebar",
            sidebarFocused: false,
        },
    )).toBe("toggle_sidebar");
    expect(jsonlViewKeyAction(
        { name: "down" },
        { sidebarFocused: true },
    )).toBe("sidebar");
});

test("HUD, palette, and typing are blocked until resume", () => {
    expect(jsonlViewKeyAction(
        { name: "tab", shift: true },
        { globalBinding: "dials.open", sidebarFocused: false },
    )).toBe("block");
    expect(jsonlViewKeyAction(
        { name: "p", ctrl: true },
        { globalBinding: "open_palette", sidebarFocused: false },
    )).toBe("block");
    expect(jsonlViewKeyAction(
        { name: "x" },
        { sidebarFocused: false },
    )).toBe("block");
});
