import { expect, test } from "bun:test";

import {
    IDLE_NOTICE_CHORD_LINE,
    IDLE_NOTICE_PROSE,
    idleNoticeChordsFor,
    idleNoticeProseLines,
    JSONL_VIEW_SCROLL_IDS,
    jsonlViewKeyAction,
    RESUME_CARET,
    RESUME_CARET_BLINK_MS,
    resumeCaretVisible,
    resumeOverlayLabelText,
    RESUME_OVERLAY_TEXT,
} from "../../clients/tui/resume-overlay.ts";

test("the composer slot says only how to carry on", () => {
    // Nothing about being closed, and no chord list: the slot is one line
    // about the conversation in front of the reader.
    expect(RESUME_OVERLAY_TEXT)
        .toBe("Start typing or enter to continue this session");
    expect(RESUME_OVERLAY_TEXT).not.toContain("closed");
    expect(RESUME_OVERLAY_TEXT).not.toContain("ctrl+");
});

test("the resume actions stand out from the muted explanation", () => {
    const label = resumeOverlayLabelText("#ffffff", "#777777");
    expect(label.chunks.map((chunk) => chunk.text)).toEqual([
        "Start typing",
        " or ",
        "enter",
        " to continue this session",
    ]);
    const colors = label.chunks.map((chunk) => String(chunk.fg));
    expect(colors[0]).toBe(colors[2]);
    expect(colors[1]).toBe(colors[3]);
    expect(colors[0]).not.toBe(colors[1]);
});

test("the block above says idle, and says it ends by typing", () => {
    expect(IDLE_NOTICE_PROSE).toContain("idle");
    expect(IDLE_NOTICE_PROSE).toContain("as soon as you type");
    expect(IDLE_NOTICE_PROSE).not.toContain("closed");
    expect(IDLE_NOTICE_CHORD_LINE)
        .toBe(
            "enter continue · esc home · Ctrl+N new · Ctrl+R all · Ctrl+P commands",
        );
});

test("the prose breaks to the columns it is given", () => {
    for (const columns of [24, 48, 72, 200]) {
        const lines = idleNoticeProseLines(columns);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(columns);
        }
        expect(lines.join(" ")).toBe(IDLE_NOTICE_PROSE);
    }
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

test("Ctrl+Shift+[ and ] cycle live sessions from a file view", () => {
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
    expect(jsonlViewKeyAction(
        { name: "left" },
        {
            sidebarFocused: false,
            sidebarVisible: true,
        },
    )).toBe("focus_sidebar");
    expect(jsonlViewKeyAction(
        { name: "left" },
        {
            sidebarFocused: false,
            sidebarVisible: false,
        },
    )).toBe("block");
});

test("Ctrl+N starts a new chat from the file view", () => {
    expect(jsonlViewKeyAction(
        { name: "n", ctrl: true },
        {
            globalBinding: "workspace_new_session",
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

test("Ctrl+P opens the palette from a closed file", () => {
    expect(jsonlViewKeyAction(
        { name: "p", ctrl: true },
        { globalBinding: "open_palette", sidebarFocused: false },
    )).toBe("palette");
});

test("search chords pass through a closed file to the global handlers", () => {
    for (const globalBinding of ["search_conversation", "search_sessions"]) {
        expect(jsonlViewKeyAction(
            { name: "f", ctrl: true },
            { globalBinding, sidebarFocused: false },
        )).toBe("search");
    }
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

test("Ctrl+R opens the full list from a file, focused rail or not", () => {
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

test("the chord row drops from the right rather than running off the edge", () => {
    expect(idleNoticeChordsFor(80).map((chord) => chord.key))
        .toEqual(["enter", "esc", "Ctrl+N", "Ctrl+R", "Ctrl+P"]);
    // Enter remains visible first when the row gets tight.
    expect(idleNoticeChordsFor(34).map((chord) => chord.key))
        .toEqual(["enter", "esc"]);
    expect(idleNoticeChordsFor(6)).toEqual([]);
    for (const columns of [6, 12, 24, 34, 40, 80]) {
        const drawn = idleNoticeChordsFor(columns)
            .map((chord) => `${chord.key} ${chord.label}`)
            .join(" · ");
        expect(drawn.length).toBeLessThanOrEqual(columns);
    }
});

test("the caret blinks on the clock, so a skipped frame does not stall it", () => {
    // A composer with nothing typed in it has no cursor of its own, so the
    // caret is what says the keyboard would land here.
    expect(RESUME_CARET.trimEnd()).toBe("›");
    expect(resumeCaretVisible(0)).toBe(true);
    expect(resumeCaretVisible(RESUME_CARET_BLINK_MS)).toBe(false);
    expect(resumeCaretVisible(RESUME_CARET_BLINK_MS * 2)).toBe(true);
    // Two readings a full cycle apart agree however many were missed between.
    expect(resumeCaretVisible(RESUME_CARET_BLINK_MS * 40 + 7))
        .toBe(resumeCaretVisible(7));
});
