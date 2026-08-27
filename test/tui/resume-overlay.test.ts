import { expect, test } from "bun:test";

import {
    JSONL_VIEW_SCROLL_IDS,
    jsonlViewKeyAction,
    RESUME_OVERLAY_HINT,
    RESUME_OVERLAY_NEW_HINT,
    RESUME_OVERLAY_TEXT,
} from "../../clients/tui/resume-overlay.ts";

test("the notice says the session is closed and names every way in", () => {
    expect(RESUME_OVERLAY_TEXT).toBe("This session is closed.");
    expect(RESUME_OVERLAY_HINT)
        .toBe("enter to resume it · start typing to resume with your message");
    expect(RESUME_OVERLAY_NEW_HINT)
        .toBe("esc home · ctrl+n new · ctrl+r all · ctrl+p commands");
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

test("ctrl+shift+[ and ] cycle live sessions from a file view", () => {
    expect(jsonlViewKeyAction(
        { name: "[", ctrl: true, shift: true },
        {
            globalBinding: "cycle_live_session_prev",
            sidebarFocused: false,
        },
    )).toBe("cycle_session");
    expect(jsonlViewKeyAction(
        { name: "]", ctrl: true, shift: true },
        {
            globalBinding: "cycle_live_session_next",
            sidebarFocused: false,
        },
    )).toBe("cycle_session");
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

test("ctrl+n starts a new chat from the file view", () => {
    expect(jsonlViewKeyAction(
        { name: "n", ctrl: true },
        {
            workspaceBinding: "workspace_new_session",
            sidebarFocused: false,
        },
    )).toBe("new_session");
});

test("slash opens the command composer on a closed file", () => {
    expect(jsonlViewKeyAction(
        { name: "/" },
        { sidebarFocused: false },
    )).toBe("command");
});

test("ctrl+p opens the palette from a closed file", () => {
    expect(jsonlViewKeyAction(
        { name: "p", ctrl: true },
        { globalBinding: "open_palette", sidebarFocused: false },
    )).toBe("palette");
});

test("a printable key resumes the file with that key as the message", () => {
    expect(jsonlViewKeyAction({ name: "x" }, { sidebarFocused: false }))
        .toBe("type");
    expect(jsonlViewKeyAction({ name: "space" }, { sidebarFocused: false }))
        .toBe("type");
    expect(jsonlViewKeyAction(
        { name: "x", ctrl: true },
        { sidebarFocused: false },
    )).toBe("block");
});

test("the HUD stays blocked until resume", () => {
    expect(jsonlViewKeyAction(
        { name: "tab", shift: true },
        { globalBinding: "dials.open", sidebarFocused: false },
    )).toBe("block");
});

test("escape leaves the file for home", () => {
    expect(jsonlViewKeyAction({ name: "escape" }, { sidebarFocused: false }))
        .toBe("home");
});

test("a modified escape is not the way home", () => {
    for (const modifier of ["ctrl", "shift", "meta"] as const) {
        expect(jsonlViewKeyAction(
            { name: "escape", [modifier]: true },
            { sidebarFocused: false },
        )).toBe("block");
    }
});

test("ctrl+r opens the full list from a file, focused rail or not", () => {
    expect(jsonlViewKeyAction(
        { name: "r", ctrl: true },
        {
            workspaceBinding: "workspace_resume_picker",
            sidebarFocused: false,
        },
    )).toBe("resume_picker");
    // A focused rail answers its own chord, so the file view hands it over
    // rather than opening a second copy of the same list.
    expect(jsonlViewKeyAction(
        { name: "r", ctrl: true },
        {
            workspaceBinding: "workspace_resume_picker",
            sidebarFocused: true,
        },
    )).toBe("sidebar");
});
