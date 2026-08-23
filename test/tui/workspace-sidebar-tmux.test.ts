import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

test.skipIf(!tmuxAvailable)("ctrl+e opens the side bar and ctrl+e closes it", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) => value.includes("Workspace"));
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => !value.includes("Workspace ·"));
        return open;
    });

    expect(pane).toContain("Workspace · 5");
    expect(pane).toContain("this one");
    expect(pane).toContain("auth-race");
    expect(pane).toContain("relay-gui");
    expect(pane).toContain("background");
    expect(pane).toContain("provider-fall…");
    // The rail is as narrow as its rows, so it takes the short hint.
    expect(pane).toContain("↑↓/jk enter 1-9 p i/esc");
}, 60_000);

test.skipIf(!tmuxAvailable)("escape returns to chat without hiding the dock", async () => {
    const result = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const focused = await tui.paneWhere(hasFocusedWorkspace);
        tui.key("Escape");
        await Bun.sleep(100);
        tui.text("draft beside dock");
        const chat = await tui.paneWhere((value) =>
            value.includes("Workspace ·")
            && value.includes("draft beside dock")
        );
        return { focused, chat };
    });

    expect(workspaceLine(result.focused))
        .toMatch(/\[(?: > |   )\] Workspace · 5/);
    expect(result.chat).toContain("Workspace · 5");
    expect(hasFocusedWorkspace(result.chat)).toBe(false);
    expect(result.chat).toContain("draft beside dock");
}, 60_000);

test.skipIf(!tmuxAvailable)("a boxed caret blinks while the explorer has focus", async () => {
    const frames = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const firstPane = await tui.paneWhere(hasFocusedWorkspace);
        const focusedFirst = workspaceLine(firstPane);
        await Bun.sleep(520);
        const secondPane = await tui.paneWhere((value) =>
            hasFocusedWorkspace(value)
            && workspaceLine(value) !== focusedFirst
        );
        const focusedSecond = workspaceLine(secondPane);

        tui.key("Escape");
        const chatPane = await tui.paneWhere((value) =>
            value.includes("Workspace ·") && !hasFocusedWorkspace(value)
        );
        const chatFirst = workspaceLine(chatPane);
        await Bun.sleep(520);
        const chatSecond = workspaceLine(tui.pane());
        return { focusedFirst, focusedSecond, chatFirst, chatSecond };
    });

    expect(frames.focusedFirst).not.toBe(frames.focusedSecond);
    expect(frames.chatFirst).toBe(frames.chatSecond);
}, 60_000);

test.skipIf(!tmuxAvailable)("slash suggestions stay one command per row beside the dock", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere(hasFocusedWorkspace);
        tui.key("Escape");
        await tui.paneWhere((value) =>
            value.includes("Workspace ·") && !hasFocusedWorkspace(value)
        );
        tui.text("/");
        return await tui.paneWhere((value) =>
            value.includes("Workspace ·") && value.includes("/rewind")
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
        await tui.paneWhere((value) => value.includes("Workspace ·"));
        tui.text("i");
        await Bun.sleep(100);
        tui.text("insert beside dock");
        return await tui.paneWhere((value) =>
            value.includes("Workspace ·")
            && value.includes("insert beside dock")
        );
    });

    expect(pane).toContain("Workspace · 5");
    expect(pane).toContain("insert beside dock");
}, 60_000);

test.skipIf(!tmuxAvailable)("the model picker opens beside the dock", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("Workspace ·"));
        tui.key("Escape");
        await Bun.sleep(100);
        tui.text("/model");
        await tui.paneWhere((value) => value.includes("/model"));
        tui.key("Enter");
        return await tui.paneWhere((value) =>
            value.includes("Workspace ·")
            && value.includes("Select model")
        );
    }, 120, 34);

    const divider = column(pane, "│");
    expect(divider).toBeGreaterThan(0);
    expect(column(pane, "Select model")).toBeGreaterThan(divider);
}, 60_000);

test.skipIf(!tmuxAvailable)("the divider drag resizes and persists the dock", async () => {
    const result = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const before = await tui.paneWhere((value) =>
            value.includes("Workspace ·") && value.includes("│")
        );
        const divider = column(before, "│");
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
        await tui.paneWhere((value) => value.includes("Workspace ·"));
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
            (value) => compact(value).includes("/sessions/auth-race.jsonl"),
        );
        return { after, opened };
    });

    expect(selectedRow(after)).toContain("auth-race");
    // The cursor row is readable without the bar: it is the row the switch
    // named, and the pane says which transcript it went to.
    expect(compact(opened)).toContain("/sessions/auth-race.jsonl");
    expect(opened).toContain("Workspace ·");
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
            && value.includes("↑↓/jk enter 1-9 p i/esc")
        );
        const row = open.split("\n")
            .findIndex((line) => line.includes("relay-gui"));
        tui.click(20, row + 1);
        return await tui.paneWhere((value) =>
            compact(value).includes("/sessions/relay-gui.jsonl")
        );
    });

    expect(compact(opened)).toContain("/sessions/relay-gui.jsonl");
}, 60_000);

test.skipIf(!tmuxAvailable)("a digit opens the row it is drawn beside", async () => {
    const { open, opened } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) =>
            value.includes("auth-race")
            && value.includes("↑↓/jk enter 1-9 p i/esc")
        );
        tui.text("2");
        const opened = await tui.paneWhere((value) =>
            compact(value).includes("/sessions/auth-race.jsonl")
        );
        return { open, opened };
    });

    // The digit is drawn on the row it addresses, so the pane says which
    // session pressing 2 will open before it is pressed.
    const second = open.split("\n").find((line) =>
        line.includes("2") && line.includes("auth-race")
    );
    expect(second).toContain("auth-race");
    expect(compact(opened)).toContain("/sessions/auth-race.jsonl");
}, 60_000);

test.skipIf(!tmuxAvailable)("p pins the selected session to the top and it stays", async () => {
    const { pinned, reopened } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => value.includes("Workspace ·"));
        // Down twice from the top row lands on relay-gui, which is neither
        // first nor in the background group.
        tui.key("Down");
        tui.key("Down");
        await tui.paneWhere((value) =>
            selectedRow(value).includes("relay-gui")
        );
        tui.text("p");
        const pinned = await tui.paneWhere((value) => value.includes("pinned"));
        tui.bytes(CTRL_E);
        await tui.paneWhere((value) => !value.includes("Workspace ·"));
        tui.bytes(CTRL_E);
        const reopened = await tui.paneWhere((value) => value.includes("pinned"));
        return { pinned, reopened };
    });

    for (const frame of [pinned, reopened]) {
        const rows = frame.split("\n");
        const heading = rows.findIndex((line) => line.includes("pinned"));
        expect(heading).toBeGreaterThan(-1);
        expect(rows[heading + 1]).toContain("relay-gui");
        // The pin is a heading and a sort key, so the pinned row is the first
        // row the digits address.
        expect(rows[heading + 1]).toMatch(/\b1\s+.*relay-gui/);
    }
}, 60_000);

test.skipIf(!tmuxAvailable)("every state the side bar shows has a text marker", async () => {
    const pane = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        return await tui.paneWhere((value) => value.includes("Workspace ·"));
    });

    const row = (title: string): string =>
        pane.split("\n").find((line) => line.includes(title)) ?? "";
    // Waiting and working come from the pushed work index, idle from the
    // roster. Each is a character, never only a colour.
    expect(row("auth-race")).toContain("? auth-race");
    expect(row("relay-gui")).toContain("* relay-gui");
    expect(row("auth-refactor")).toContain("+ auth-refactor");
    // Where you already are, said in words.
    expect(row("this one")).toContain("(here)");
    expect(pane).toContain("background");
}, 60_000);

test.skipIf(!tmuxAvailable)("a session created while the pane is open appears in it", async () => {
    const { before, after } = await withTui(async (tui) => {
        await tui.settled();
        tui.bytes(CTRL_E);
        const before = await tui.paneWhere((value) =>
            value.includes("Workspace ·")
        );
        // The host registers the session and pushes the index that mentions
        // it. Nothing here reopens the pane.
        const after = await tui.paneWhere((value) =>
            value.includes("late-arrival")
        );
        return { before, after };
    }, 120, 34, { VERA_TEST_PUSH_WORK_AFTER_MS: "1500" });

    expect(before).not.toContain("late-arrival");
    expect(after).toContain("Workspace · 6");
    // Listed with the status the same push carried, not as an idle row.
    expect(after.split("\n").find((line) => line.includes("late-arrival")))
        .toContain("? late-arrival");
}, 60_000);

test.skipIf(!tmuxAvailable)("at a wide size the listing is a left rail beside the transcript", async () => {
    const { open, closed } = await withTui(async (tui) => {
        await tui.settled();
        tui.text("hello");
        tui.key("Enter");
        await tui.paneWhere((value) => value.includes("\u203a hello"));
        tui.bytes(CTRL_E);
        const open = await tui.paneWhere((value) => value.includes("Workspace \u00b7"));
        tui.bytes(CTRL_E);
        const closed = await tui.paneWhere((value) =>
            !value.includes("Workspace \u00b7")
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
        return await tui.paneWhere((value) => value.includes("Workspace \u00b7"));
    }, 70, 34);

    expect(open).toContain("auth-race");
    expect(workspaceRailColumns(70)).toBeUndefined();
    // Held off the left edge, which is what a centred card looks like and what
    // a rail never does.
    expect(column(open, "Workspace \u00b7")).toBeGreaterThan(2);
}, 60_000);

/** The column the text starts in, or -1 when the pane does not show it. */
function column(pane: string, text: string): number {
    const line = pane.split("\n").find((candidate) => candidate.includes(text));
    return line === undefined ? -1 : line.indexOf(text);
}

function workspaceLine(pane: string): string {
    return pane.split("\n").find((line) => line.includes("Workspace")) ?? "";
}

function hasFocusedWorkspace(pane: string): boolean {
    return /\[(?: > |   )\] Workspace ·/.test(workspaceLine(pane));
}

/** The selected row carries `›`, so navigation remains testable without color. */
function selectedRow(pane: string): string {
    return pane.split("\n").find((line) => line.includes("›")) ?? "";
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
        }exec ${quote(process.execPath)} run ${quote(CHILD)}`,
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
