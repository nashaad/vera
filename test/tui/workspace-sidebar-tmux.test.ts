import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { BRAILLE_FRAMES } from "../../clients/tui/activity-pulse.ts";
import { workspaceRailColumns } from "../../clients/tui/workspace-sidebar.ts";
import { ownTmuxServer } from "../support/uat-process-owner.ts";
import { killTmuxServer } from "../support/kill-tmux-server.ts";

/**
 * The workspace side bar driven through a real terminal.
 *
 * Every fact asserted here is text, never colour or position, except the one
 * assertion that reads the highlight bar, which has a text marker beside it.
 */

const CHILD = "test/support/tui-work-tab-child.ts";
const RESUME_CHILD = "test/support/tui-resume-child.ts";
const homes: string[] = [];
const sockets: string[] = [];

afterAll(() => {
    for (const socket of sockets.splice(0)) killServer(socket);
    for (const home of homes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
    }
});

const tmuxAvailable = runTmux("probe-unused", ["-V"], true).ok;

/** ctrl+e, which is the chord that both opens and closes the pane. */
const CTRL_E = ["05"];

/** ctrl+r, the chord that opens the full session list from the rail. */
const CTRL_R = ["12"];

test.skipIf(!tmuxAvailable)("ctrl+e opens the side bar and ctrl+e closes it", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) => value.includes("[ VERA ]"));
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => !value.includes("[ VERA ] ·"));
        return open;
    });

    expect(pane).toContain("[ VERA ] · 6");
    expect(pane).toContain("this one");
    expect(pane).toContain("auth-race");
    expect(pane).toContain("relay-gui");
    expect(pane).toContain("provider-fall…");
    expect(pane).not.toContain("Resume session");
    expect(pane).toContain("ctrl+r · all sessions");
    expect(pane).toContain("Move    ↑↓  j/k");
    expect(pane).toContain("Resume  ctrl+r");
    expect(pane).toContain("Hide    ctrl+e");
    const rows = pane.split("\n");
    const lastSession = rows.findIndex((line) => line.includes("auth-refactor"));
    const footerTop = rows.findIndex((line) => line.includes("Move    ↑↓"));
    const footerBottom = rows.findIndex((line) => line.includes("Hide    ctrl+e"));
    expect(footerTop).toBeGreaterThan(lastSession);
    expect(rows.slice(lastSession, footerTop).some((line) => line.includes("──")))
        .toBe(true);
    expect(rows.length - footerBottom).toBeLessThanOrEqual(3);
}, 60_000);

test.skipIf(!tmuxAvailable)("the sidebar resume action opens from a file view", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("[ VERA ] · 2"));
        tui.key("Down");
        tui.key("Enter");
        await tui.paneWhere((value) =>
            value.includes("SAVED TRANSCRIPT LOADED")
            && value.includes("ctrl+n new")
        );

        // The sidebar action remains available while a closed file is shown.
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) =>
            value.includes("Resume  ctrl+r")
            && !value.includes("Resume session")
        );
        tui.bytes(CTRL_R);
        // A file has no worker behind it, so Enter is not a switch away from
        // anything: the footer offers to open the row and nothing more.
        return await tui.paneWhere((value) =>
            value.includes("Continue the theme picker")
            && value.includes("⏎ open")
            && !value.includes("stop & switch")
        );
    }, 100, 34, {}, RESUME_CHILD);

    expect(pane).toContain("The one already open");
}, 60_000);

test.skipIf(!tmuxAvailable)("escape hides the side bar and returns to chat", async () => {
    const result = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const focused = await tui.paneWhere(hasFocusedWorkspace);
        tui.key("Escape");
        await Bun.sleep(100);
        tui.text("draft after hide");
        const chat = await tui.paneWhere((value) =>
            value.includes("draft after hide")
        );
        return { focused, chat };
    });

    expect(workspaceLine(result.focused))
        .toMatch(/\[ VERA \] · 6/);
    expect(result.chat).not.toContain("[ VERA ] · 6");
    expect(result.chat).toContain("draft after hide");
}, 60_000);

test.skipIf(!tmuxAvailable)("the rail's rule and edge say which side has the keyboard", async () => {
    const frames = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const rail = await tui.paneWhere(hasFocusedWorkspace);
        tui.key("i");
        const chat = await tui.paneWhere((value) =>
            value.includes("[ VERA ] ·") && !hasFocusedWorkspace(value)
        );
        return { rail, chat, title: railTitle(workspaceLine(rail)) };
    });

    // Two glyphs, no colour: the rule under the title and the edge beside it
    // both thicken while the rail answers keys.
    expect(frames.rail).toContain("━");
    expect(frames.rail).toContain("┃");
    expect(frames.chat).not.toContain("━");
    expect(frames.chat).toContain("│");
    // The title itself is the same on both sides, which is the point of it.
    expect(railTitle(workspaceLine(frames.chat))).toBe(frames.title);
}, 60_000);

test.skipIf(!tmuxAvailable)("slash suggestions stay one command per row beside the dock", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere(hasFocusedWorkspace);
        tui.key("i");
        await tui.paneWhere((value) =>
            value.includes("[ VERA ] ·") && !hasFocusedWorkspace(value)
        );
        tui.text("/");
        return await tui.paneWhere((value) =>
            value.includes("[ VERA ] ·") && value.includes("/rewind")
        );
    }, 120, 46);

    const divider = column(pane, "│");
    const chatLines = pane.split("\n").map((line) => line.slice(divider + 1));
    const first = chatLines.findIndex((line) => line.includes("/rewind"));
    const composerTop = chatLines.findIndex(
        (line, index) => index > first && line.includes("╭"),
    );
    const wrappedOrphans = chatLines.slice(first, composerTop)
        .filter((line) => line.trim().length > 0 && !line.includes("/"));

    expect(first).toBeGreaterThanOrEqual(0);
    expect(composerTop).toBeGreaterThan(first);
    expect(wrappedOrphans).toEqual([]);
}, 60_000);

test.skipIf(!tmuxAvailable)("i returns to chat without hiding the dock", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("[ VERA ] ·"));
        tui.text("i");
        await Bun.sleep(100);
        tui.text("insert beside dock");
        return await tui.paneWhere((value) =>
            value.includes("[ VERA ] ·")
            && value.includes("insert beside dock")
        );
    });

    expect(pane).toContain("[ VERA ] · 6");
    expect(pane).toContain("insert beside dock");
}, 60_000);

test.skipIf(!tmuxAvailable)("the model picker covers the dock like every other dialog", async () => {
    // The picker used to squeeze into whatever the dock left beside it, which
    // broke the tab strip (it never truncates, so "Providers" ran off the
    // narrowed card). It now hides the dock and takes its usual full width,
    // the same as every dialog that isn't the picker.
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("[ VERA ] ·"));
        tui.key("Escape");
        await Bun.sleep(100);
        tui.text("/model");
        await tui.paneWhere((value) => value.includes("/model"));
        tui.key("Enter");
        return await tui.paneWhere((value) =>
            value.includes("Select model")
            && !value.includes("[ VERA ] ·")
        );
    }, 120, 34);

    expect(pane).toContain("Select model");
    expect(pane).not.toContain("[ VERA ] ·");
    // Full width again: every tab stop is on screen, not clipped by a card
    // narrowed to fit beside the dock.
    expect(pane).toContain("Providers ^e");
}, 60_000);

test.skipIf(!tmuxAvailable)("the scrim behind a dialog reaches the last row", async () => {
    const colored = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("Hide    ctrl+e"));
        tui.click(80, 6);
        await tui.paneWhere((value) => value.includes("Focus  ctrl+e"));
        tui.text("/model");
        await tui.paneWhere((value) => value.includes("/model"));
        tui.key("Enter");
        await tui.paneWhere((value) => value.includes("Select model"));
        return await tui.coloredWhere((value) => value.includes("Select model"));
    }, 120, 40);

    // The card is centred, so the row under it and the last row of the screen
    // are both scrim and nothing else. They have to be the same shade: the
    // scrim used to stop a row short and leave an undimmed strip along the
    // bottom edge.
    const grounds = rowGrounds(colored);
    const last = grounds.findLastIndex((ground) => ground !== "default");
    expect(last).toBeGreaterThan(0);
    expect(grounds[last]).toBe(grounds[1]);
    expect(grounds[last]).not.toBe("default");
}, 60_000);

test.skipIf(!tmuxAvailable)("the divider drag resizes and persists the dock", async () => {
    const result = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const before = await tui.paneWhere((value) =>
            value.includes("[ VERA ] ·") && value.includes("┃")
        );
        // The rail has the keyboard here, so its edge is the heavy one.
        const divider = column(before, "┃");
        const chatBefore = column(before, "Start a conversation");
        tui.drag(divider + 1, 5, 65, 5);
        const after = await tui.paneWhere((value) =>
            column(value, "Start a conversation") > chatBefore + 5
        );
        await Bun.sleep(100);
        const preferences = JSON.parse(readFileSync(
            join(tui.home, ".vera", "profiles", "default", "tui.json"),
            "utf8",
        )) as { workspace_sidebar_width?: number };
        return { after, width: preferences.workspace_sidebar_width };
    }, 120, 34);

    expect(column(result.after, "Start a conversation")).toBeGreaterThan(60);
    expect(result.width).toBeGreaterThan(workspaceRailColumns(120)!);
}, 60_000);

test.skipIf(!tmuxAvailable)("the arrows and j/k move the cursor and enter opens the row", async () => {
    const { after, opened } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("[ VERA ] ·"));
        tui.key("Down");
        const after = await tui.paneWhere(
            (value) => selectedRow(value).includes("auth-race"),
        );
        tui.text("k");
        await tui.paneWhere(
            (value) => selectedRow(value).includes("this one"),
        );
        tui.text("j");
        await tui.paneWhere(
            (value) => selectedRow(value).includes("auth-race"),
        );
        tui.key("Enter");
        const opened = await tui.paneWhere(
            (value) =>
                value.includes("Could not switch conversation: OPENED")
                && value.includes("auth-race"),
        );
        return { after, opened };
    });

    expect(selectedRow(after)).toContain("auth-race");
    // j/k only moved the highlight. The viewed transcript is still this one
    // until Enter, which is when the path in the pane changes.
    expect(after).toContain("this one");
    expect(after).not.toContain("[ this one ]");
    expect(compact(after)).not.toContain("/sessions/auth-race.jsonl");
    expect(opened).toContain("OPENED /sessions/auth-race.");
    expect(opened).toContain("[ VERA ] ·");
}, 60_000);

/** kitty CSI u for ctrl+shift+] (`]` is codepoint 93, modifiers 6). */
const CTRL_SHIFT_RIGHT_BRACKET = Array.from(
    "\u001b[93;6u",
    (character) => character.charCodeAt(0).toString(16).padStart(2, "0"),
);

test.skipIf(!tmuxAvailable)("ctrl+shift+] opens the next live session from chat", async () => {
    const opened = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_SHIFT_RIGHT_BRACKET);
        return await tui.paneWhere((value) =>
            compact(value).includes("/sessions/")
            && !compact(value).includes("/sessions/work-tab-child.jsonl")
        );
    });

    expect(compact(opened)).toMatch(/\/sessions\/[a-z0-9-]+\.jsonl/);
    expect(compact(opened)).not.toContain("/sessions/work-tab-child.jsonl");
}, 60_000);

test.skipIf(!tmuxAvailable)("ctrl+d and ctrl+u jump half a page without opening", async () => {
    const CTRL_D = ["04"];
    const CTRL_U = ["15"];
    const { before, afterDown, afterUp } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const before = await tui.paneWhere((value) =>
            value.includes("[ VERA ] · 46")
        );
        const selectedBefore = selectedRow(before);
        tui.bytes(CTRL_D);
        const afterDown = await tui.paneWhere((value) => {
            const row = selectedRow(value);
            return row.length > 0 && row !== selectedBefore;
        });
        tui.bytes(CTRL_U);
        const afterUp = await tui.paneWhere(
            (value) => selectedRow(value) === selectedBefore,
        );
        return { before, afterDown, afterUp };
    }, 100, 34, { VERA_TEST_MANY: "1" });

    expect(selectedRow(afterDown)).not.toBe(selectedRow(before));
    expect(selectedRow(afterUp)).toBe(selectedRow(before));
    // Half-page is highlight only. The viewed transcript does not follow.
    expect(compact(afterDown)).not.toContain("/sessions/bulk-");
    expect(afterDown).not.toContain("[ this one ]");
}, 60_000);

test.skipIf(!tmuxAvailable)("a click opens the row the mouse landed on", async () => {
    const opened = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        // The click coordinate comes from one frame and is never retried, so
        // the frame has to be the finished one: the footer is drawn last, and
        // a row read from a half-painted pane clicks the wrong session.
        const open = await tui.paneWhere((value) =>
            value.includes("relay-gui")
            && value.includes("provider-fall…")
            && value.includes("Hide    ctrl+e")
        );
        const row = open.split("\n")
            .findIndex((line) => line.includes("relay-gui"));
        tui.click(20, row + 1);
        return await tui.paneWhere((value) =>
            value.includes("Could not switch conversation: OPENED")
            && value.includes("relay-gui")
        );
    });

    expect(opened).toContain("OPENED /sessions/relay-gui.");
}, 60_000);

test.skipIf(!tmuxAvailable)("the chord block narrows to what the chat can press", async () => {
    const { focused, clicked } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const focused = await tui.paneWhere((value) =>
            value.includes("Hide    ctrl+e")
        );
        // A click in the conversation is the keyboard leaving the rail. The
        // rail stays on screen, and so do the two chords that answer from
        // where the cursor now is.
        tui.click(80, 6);
        const clicked = await tui.paneWhere((value) =>
            value.includes("[ VERA ]") && !value.includes("Hide    ctrl+e")
        );
        return { focused, clicked };
    });

    expect(focused).toContain("Move    ↑↓  j/k");
    expect(focused).toContain("Cycle   ctrl+shift+[ ]");
    expect(clicked).toContain("[ VERA ]");
    expect(clicked).toContain("Cycle  ctrl+shift+[ ]");
    expect(clicked).toContain("Focus  ctrl+e");
    expect(clicked).not.toContain("Move    ↑↓  j/k");
    expect(clicked).not.toContain("Pin");
}, 60_000);

test.skipIf(!tmuxAvailable)("the closed rail is named under the composer", async () => {
    const { closed, open } = await withTui(async (tui) => {
        await tui.settled();
        const closed = await tui.paneWhere((value) =>
            value.includes("ctrl+p commands")
        );
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) => value.includes("[ VERA ]"));
        return { closed, open };
    });

    // Nothing else on screen says how to reach the rail while it is away.
    expect(closed).toContain("ctrl+e agent sidebar");
    // Once it is there it carries its own chords, `ctrl+e` among them.
    expect(open).not.toContain("ctrl+e agent sidebar");
    expect(open).toContain("Hide    ctrl+e");
}, 60_000);

test.skipIf(!tmuxAvailable)("a digit opens the row it is drawn beside", async () => {
    const { open, opened } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) =>
            value.includes("auth-race")
            && value.includes("Hide    ctrl+e")
        );
        tui.text("2");
        const opened = await tui.paneWhere((value) =>
            value.includes("Could not switch conversation: OPENED")
            && value.includes("auth-race")
        );
        return { open, opened };
    });

    // The digit is drawn on the row it addresses, so the pane says which
    // session pressing 2 will open before it is pressed.
    const second = open.split("\n").find((line) =>
        line.includes("2") && line.includes("auth-race")
    );
    expect(second).toContain("auth-race");
    expect(opened).toContain("OPENED /sessions/auth-race.");
}, 60_000);

test.skipIf(!tmuxAvailable)("p pins the selected session to the top and it stays", async () => {
    const { pinned, reopened } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("[ VERA ] ·"));
        // Down twice from the top row lands on relay-gui, which is neither
        // first nor an idle recents row.
        tui.key("Down");
        tui.key("Down");
        await tui.paneWhere((value) =>
            selectedRow(value).includes("relay-gui")
        );
        tui.text("p");
        const pinned = await tui.paneWhere((value) => value.includes("pinned"));
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => !value.includes("[ VERA ] ·"));
        tui.bytes(CTRL_E);
        const reopened = await tui.paneWhere((value) => value.includes("pinned"));
        return { pinned, reopened };
    });

    for (const frame of [pinned, reopened]) {
        const rows = frame.split("\n");
        const heading = rows.findIndex((line) => line.includes("pinned"));
        expect(heading).toBeGreaterThan(-1);
        expect(rows[heading + 1]).toContain("relay-gui");
        // The pin is a heading and a sort key. Digits address running
        // sessions in listing order, wherever they sit.
        expect(rows[heading + 1]).toMatch(/\b\d\s+.*relay-gui/);
    }
}, 60_000);

test.skipIf(!tmuxAvailable)("every state the side bar shows has a text marker", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        return await tui.paneWhere((value) => value.includes("[ VERA ] ·"));
    });

    const row = (title: string): string =>
        pane.split("\n").find((line) => line.includes(title)) ?? "";
    // Waiting and working come from the pushed work index, idle from the
    // roster. Each is a character, never only a colour.
    expect(row("auth-race")).toContain("! auth-race");
    expect(row("relay-gui")).toMatch(
        new RegExp(`[${BRAILLE_FRAMES.join("")}] relay-gui`),
    );
    expect(row("auth-refactor")).toContain("auth-refactor");
    expect(row("auth-refactor")).not.toContain("● auth-refactor");
    // Live idle is a finished turn only while it is still recent.
    expect(row("this one")).toContain("● this one");
    expect(row("this one")).not.toContain("[ this one ]");
    expect(row("this one")).toContain("❯");
    expect(row("old chat")).toContain("old chat");
    expect(row("old chat")).not.toContain("● old chat");
    expect(pane.split("\n").some((line) => line.trim() === "background"))
        .toBe(false);
}, 60_000);

test.skipIf(!tmuxAvailable)("a session created while the pane is open appears in it", async () => {
    const { before, after } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const before = await tui.paneWhere((value) =>
            value.includes("[ VERA ] ·")
        );
        // The host registers the session and pushes the index that mentions
        // it. Nothing here reopens the pane.
        const after = await tui.paneWhere((value) =>
            value.includes("late-arrival")
        );
        return { before, after };
    }, 120, 34, { VERA_TEST_PUSH_WORK_AFTER_MS: "1500" });

    expect(before).not.toContain("late-arrival");
    expect(after).toContain("[ VERA ] · 7");
    // Listed with the status the same push carried, not as an idle row.
    expect(after.split("\n").find((line) => line.includes("late-arrival")))
        .toContain("! late-arrival");
}, 60_000);

test.skipIf(!tmuxAvailable)("at a wide size the listing is a left rail beside the transcript", async () => {
    const { open, closed } = await withTui(async (tui) => {
        await tui.settled();
        tui.text("hello");
        tui.key("Enter");
        await tui.paneWhere((value) => value.includes("\u203a hello"));
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) => value.includes("[ VERA ] \u00b7"));
        tui.bytes(CTRL_E);
        const closed = await tui.paneWhere((value) =>
            !value.includes("[ VERA ] \u00b7")
        );
        return { open, closed };
    }, 120, 34);

    // The columns the rail draws its rows in. What is drawn to the right of
    // them is the transcript, still on screen beside the listing.
    const rail = workspaceRailColumns(120)!;
    for (const title of ["auth-race", "relay-gui", "provider-fallback"]) {
        expect(column(open, title)).toBeGreaterThanOrEqual(0);
        expect(column(open, title)).toBeLessThan(rail);
    }
    // The transcript is beside the rail and still readable, which is the whole
    // difference between a rail and a card, and it reflowed to make room.
    expect(column(open, "\u203a hello")).toBeGreaterThanOrEqual(rail);
    // The listing and the conversation are on screen at the same time.
    expect(open).toContain("this one");
    expect(open).toContain("› hello");
    // Closing gives the columns back.
    expect(column(closed, "\u203a hello")).toBeLessThan(rail);
}, 60_000);

test.skipIf(!tmuxAvailable)("at a narrow size the listing stays a card over the transcript", async () => {
    const open = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        return await tui.paneWhere((value) => value.includes("[ VERA ] \u00b7"));
    }, 70, 34);

    expect(open).toContain("auth-race");
    expect(workspaceRailColumns(70)).toBeUndefined();
    // Held off the left edge, which is what a centred card looks like and what
    // a rail never does.
    expect(column(open, "[ VERA ] \u00b7")).toBeGreaterThan(2);
}, 60_000);

/** The column the text starts in, or -1 when the pane does not show it. */
function column(pane: string, text: string): number {
    const line = pane.split("\n").find((candidate) => candidate.includes(text));
    return line === undefined ? -1 : line.indexOf(text);
}

/**
 * The ground each row starts on, read from a coloured capture.
 *
 * tmux only writes an escape where a run changes, so a row with none keeps
 * whatever the row above it left behind.
 */
function rowGrounds(colored: string): string[] {
    let ground = "default";
    return colored.split("\n").map((line) => {
        const lead = /^(?:\x1b\[[\d;]*m)*?\x1b\[48;2;(\d+;\d+;\d+)m/
            .exec(line);
        if (lead?.[1] !== undefined) ground = lead[1];
        const runs = line.matchAll(/\x1b\[48;2;(\d+;\d+;\d+)m/g);
        const started = ground;
        for (const run of runs) ground = run[1] ?? ground;
        return started;
    });
}

/** The rail's own share of a row, up to whichever edge glyph is drawn. */
function railTitle(line: string): string {
    const edge = Math.max(line.indexOf("\u2502"), line.indexOf("\u2503"));
    return edge === -1 ? line : line.slice(0, edge);
}

function workspaceLine(pane: string): string {
    return pane.split("\n").find((line) => line.includes("[ VERA ]")) ?? "";
}

/**
 * The rail's title is its name and does not move with focus, so the rule
 * under it is what says which side the keyboard is on. Heavy is the rail.
 */
function hasFocusedWorkspace(pane: string): boolean {
    return pane.split("\n").some((line) => line.includes("━"));
}

/** The selected row carries `❯`, so navigation remains testable without color. */
function selectedRow(pane: string): string {
    return pane.split("\n").find((line) => line.includes("❯")) ?? "";
}

/** A narrow chat column can wrap a diagnostic path across terminal rows. */
function compact(pane: string): string {
    return pane.replaceAll(/[\s│]/g, "");
}

interface DrivenTui {
    readonly home: string;
    pane(): string;
    /** The frame with its colours, for the highlight bar the text loses. */
    colored(): string;
    coloredWhere(
        predicate: (colored: string) => boolean,
        timeoutMs?: number,
    ): Promise<string>;
    paneWhere(
        predicate: (pane: string) => boolean,
        timeoutMs?: number,
    ): Promise<string>;
    text(value: string): void;
    key(value: string): void;
    /** Raw bytes, for the sequences a terminal sends unasked. */
    bytes(hex: readonly string[]): void;
    /** An SGR mouse report, as a terminal sends one. */
    mouse(kind: "move" | "wheel", column: number, row: number): void;
    bellRang(): boolean;
    /** An SGR left-button press and release on one cell. */
    click(column: number, row: number): void;
    /** An SGR left-button drag, with one-based terminal coordinates. */
    drag(
        startColumn: number,
        startRow: number,
        endColumn: number,
        endRow: number,
    ): void;
    /** Waits for the composer, which is when a person would start pressing keys. */
    settled(): Promise<void>;
    openWorkTab(): Promise<void>;
    openSearch(): Promise<void>;
}

async function withTui<T>(
    body: (tui: DrivenTui) => Promise<T>,
    width = 100,
    height = 34,
    env: Readonly<Record<string, string>> = {},
    child = CHILD,
): Promise<T> {
    const socket = `vera-work-tab-${process.pid}-${randomUUID()}`;
    const home = mkdtempSync(join(tmpdir(), "vera-work-tab-"));
    sockets.push(socket);
    homes.push(home);
    const session = "work";

    runTmux(socket, [
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        String(width),
        "-y",
        String(height),
        `cd ${quote(process.cwd())} && HOME=${quote(home)} VERA_HOME=${
            quote(join(home, ".vera"))
        } ${
            Object.entries(env)
                .map(([name, value]) => `${name}=${quote(value)} `)
                .join("")
        }exec ${quote(process.execPath)} run ${quote(child)}`,
    ]);
    runTmux(socket, ["set-option", "-t", session, "monitor-bell", "on"], true);

    const pane = (): string =>
        runTmux(socket, ["capture-pane", "-p", "-t", session]).output;
    const colored = (): string =>
        runTmux(socket, ["capture-pane", "-p", "-e", "-t", session]).output;
    const paneWhere = async (
        predicate: (value: string) => boolean,
        timeoutMs = 20_000,
    ): Promise<string> => {
        const deadline = Date.now() + timeoutMs;
        let last = "";
        while (Date.now() < deadline) {
            last = pane();
            if (predicate(last)) return last;
            await Bun.sleep(100);
        }
        throw new Error(`Timed out waiting for pane:\n${last}`);
    };
    const coloredWhere = async (
        predicate: (value: string) => boolean,
        timeoutMs = 20_000,
    ): Promise<string> => {
        const deadline = Date.now() + timeoutMs;
        let last = "";
        while (Date.now() < deadline) {
            last = colored();
            if (predicate(last)) return last;
            await Bun.sleep(100);
        }
        throw new Error(`Timed out waiting for pane:\n${last}`);
    };
    const text = (value: string): void => {
        runTmux(socket, ["send-keys", "-t", session, "-l", value]);
    };
    const key = (value: string): void => {
        runTmux(socket, ["send-keys", "-t", session, value]);
    };
    const bytes = (hex: readonly string[]): void => {
        runTmux(socket, ["send-keys", "-t", session, "-H", ...hex]);
    };
    const mouse = (
        kind: "move" | "wheel",
        column: number,
        row: number,
    ): void => {
        // SGR: motion with no button held is 35, wheel down is 65.
        const button = kind === "move" ? 35 : 65;
        bytes(Array.from(
            `\u001b[<${button};${column};${row}M`,
            (character) => character.charCodeAt(0).toString(16).padStart(2, "0"),
        ));
    };
    const click = (column: number, row: number): void => {
        bytes(Array.from(
            `\u001b[<0;${column};${row}M`,
            (character) => character.charCodeAt(0).toString(16).padStart(2, "0"),
        ));
        bytes(Array.from(
            `\u001b[<0;${column};${row}m`,
            (character) => character.charCodeAt(0).toString(16).padStart(2, "0"),
        ));
    };
    const bellRang = (): boolean =>
        runTmux(socket, [
            "list-windows",
            "-F",
            "#{window_bell_flag}",
            "-t",
            session,
        ]).output.trim() === "1";
    const runCommand = async (
        command: string,
        settled: (pane: string) => boolean,
    ): Promise<void> => {
        await paneWhere((value) => value.includes("Message Vera…"));
        text(command);
        await paneWhere((value) => value.includes(command));
        key("Enter");
        await paneWhere(settled);
    };

    try {
        return await body({
            home,
            pane,
            colored,
            coloredWhere,
            paneWhere,
            text,
            key,
            bytes,
            mouse,
            click,
            drag: (startColumn, startRow, endColumn, endRow) => {
                const report = (
                    button: number,
                    column: number,
                    row: number,
                    suffix: "M" | "m",
                ): void => bytes(Array.from(
                    `\u001b[<${button};${column};${row}${suffix}`,
                    (character) => character.charCodeAt(0).toString(16)
                        .padStart(2, "0"),
                ));
                report(0, startColumn, startRow, "M");
                report(32, endColumn, endRow, "M");
                report(0, endColumn, endRow, "m");
            },
            bellRang,
            settled: async () => {
                await paneWhere((value) => value.includes("Message Vera…"));
            },
            openWorkTab: () =>
                runCommand("/work", (value) => value.includes("Needs you")),
            openSearch: () =>
                runCommand("/search", (value) => value.includes("Search · all")),
        });
    } finally {
        killServer(socket);
    }
}

function killServer(socket: string): void {
    killTmuxServer(socket);
}

function runTmux(
    socket: string,
    args: readonly string[],
    tolerant = false,
): { readonly ok: boolean; readonly output: string } {
    if (args.includes("new-session")) ownTmuxServer(socket);
    const result = Bun.spawnSync(["tmux", "-L", socket, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout);
    if (result.exitCode !== 0 && !tolerant) {
        throw new Error(
            `tmux ${args.join(" ")} failed: ${
                new TextDecoder().decode(result.stderr)
            }`,
        );
    }
    return { ok: result.exitCode === 0, output };
}

function quote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
