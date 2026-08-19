import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The Work tab and the search overlay driven through a real terminal.
 *
 * Every fact asserted here is text, never colour or position, so the pane is
 * read the same way a person reads it.
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

test.skipIf(!tmuxAvailable)("the work tab lists every section it was given", async () => {
    const pane = await withTui(async (tui) => {
        await tui.openWorkTab();
        return tui.pane();
    });

    expect(pane).toContain("Work · 2 need you · 1 working");
    expect(pane).toContain("Needs you");
    expect(pane).toContain("Working");
    expect(pane).toContain("Ready to review");
    expect(pane).toContain("auth-refactor");
    // A count of what it touched, never a verdict on it.
    expect(pane).toContain("5 files changed");
    expect(pane).toContain("Done recently");
    expect(pane).toContain("> auth-race");
    expect(pane).toContain("Approval");
    expect(pane).toContain("bash bun migrate --production");
    expect(pane).toContain("2m ago");
    expect(pane).toContain("browser-tests");
    expect(pane).toContain("Which environment fails?");
    expect(pane).toContain("Running edit");
    expect(pane).toContain("2 subagents");
    expect(pane).toContain("Finished, unread result");
    expect(pane).toContain("↑↓ select   enter open   esc back");
    // Counted on the parent, never listed beside it.
    expect(pane).not.toContain("sub-one");
}, 60_000);

test.skipIf(!tmuxAvailable)("the arrows move the pointer and escape goes back", async () => {
    const { moved, closed } = await withTui(async (tui) => {
        await tui.openWorkTab();
        tui.key("Down");
        const moved = await tui.paneWhere((pane) =>
            pane.includes("> browser-tests"));
        tui.key("Escape");
        const closed = await tui.paneWhere((pane) => !pane.includes("Needs you"));
        return { moved, closed };
    });

    expect(moved).toContain("  auth-race");
    expect(moved).toContain("> browser-tests");
    expect(closed).toContain("Message Vera…");
}, 60_000);

test.skipIf(!tmuxAvailable)("a narrow terminal keeps every row on one line", async () => {
    const pane = await withTui(async (tui) => {
        await tui.openWorkTab();
        return tui.pane();
    }, 52, 20);

    expect(pane).toContain("auth-race");
    expect(pane).toContain("2m ago");
    // The reason column is what a narrow terminal drops.
    expect(pane).not.toContain("Approval");
    for (const line of pane.split("\n")) {
        expect(line.length, line).toBeLessThanOrEqual(52);
    }
}, 60_000);

test.skipIf(!tmuxAvailable)("search groups hits by session and names each kind", async () => {
    const { found, filtered, widened } = await withTui(async (tui) => {
        await tui.openSearch();
        tui.text("fallback");
        const found = await tui.paneWhere((pane) => pane.includes("relay-gui"));
        tui.key("Tab");
        const filtered = await tui.paneWhere((pane) =>
            pane.includes("Search · messages"));
        tui.key("C-w");
        const widened = await tui.paneWhere((pane) =>
            pane.includes("everywhere"));
        return { found, filtered, widened };
    });

    expect(found).toContain("Search · all · this workspace");
    expect(found).toContain("relay-gui");
    // The pointer sits on the hit rather than the session, because a hit is
    // what enter opens.
    expect(found).toContain("> you: if the provider fallback kicks in");
    expect(found).toContain("you: if the provider fallback kicks in");
    expect(found).toContain("provider-fallback");
    expect(found).toContain("agent: the fallback ladder degrades in place");
    expect(found).toContain("ran: bun test tests/unit/fallback");
    expect(found).toContain("tab filter");
    expect(filtered).toContain("Search · messages · this workspace");
    expect(widened).toContain("Search · messages · everywhere");
}, 60_000);

test.skipIf(!tmuxAvailable)("a filter with no hits says so rather than showing the old ones", async () => {
    const pane = await withTui(async (tui) => {
        await tui.openSearch();
        tui.text("fallback");
        await tui.paneWhere((candidate) => candidate.includes("relay-gui"));
        // The child answers the files filter with nothing.
        tui.key("Tab");
        tui.key("Tab");
        tui.key("Tab");
        return tui.paneWhere((candidate) => candidate.includes("Search · files"));
    });

    expect(pane).toContain("No matches.");
    expect(pane).not.toContain("you: if the provider fallback kicks in");
}, 60_000);

test.skipIf(!tmuxAvailable)("enter opens the session the row names", async () => {
    const pane = await withTui(async (tui) => {
        await tui.openWorkTab();
        tui.key("Enter");
        return tui.paneWhere((value) => value.includes("OPENED"));
    });

    // The child refuses the resume and reports the path it was handed, which
    // is the routing decision this asserts.
    expect(pane).toContain("OPENED /sessions/auth-race.jsonl");
}, 60_000);

test.skipIf(!tmuxAvailable)("a new row rings an unfocused terminal and a focused one stays quiet", async () => {
    for (const scene of [
        { focus: "out", sequence: ["1b", "5b", "4f"], rings: true },
        { focus: "in", sequence: ["1b", "5b", "49"], rings: false },
    ]) {
        const rang = await withTui(async (tui) => {
            await tui.paneWhere((value) => value.includes("Message Vera…"));
            tui.bytes(scene.sequence);
            await tui.paneWhere((value) =>
                value.includes("ready") || value.includes("Message Vera…"));
            // The child pushes a second index with one more session waiting.
            await tui.openWorkTab();
            await tui.paneWhere((value) => value.includes("late-arrival"));
            return tui.bellRang();
        }, 100, 34, { VERA_TEST_PUSH_WORK_AFTER_MS: "3000" });

        expect(rang, `focus ${scene.focus}`).toBe(scene.rings);
    }
}, 90_000);

test.skipIf(!tmuxAvailable)("opening a result lands on the match, not the tail", async () => {
    const { before, after } = await withTui(async (tui) => {
        // The transcript opens at its end, far past the row that matched.
        const before = await tui.paneWhere((value) =>
            value.includes("filler line 59"));
        await tui.openSearch();
        tui.text("fallback");
        await tui.paneWhere((value) => value.includes("relay-gui"));
        tui.key("Enter");
        const after = await tui.paneWhere((value) => value.includes("MATCHED"));
        return { before, after };
    }, 100, 30, { VERA_TEST_HISTORY: "1" });

    expect(before).not.toContain("MATCHED");
    expect(before).toContain("filler line 59");
    // The matched row is on screen and the tail is not, which is the whole
    // reason searching beat scrolling.
    expect(after).toContain("MATCHED the provider fallback question");
    expect(after).not.toContain("filler line 59");
}, 60_000);

test.skipIf(!tmuxAvailable)("a match in another session never scrolls this one", async () => {
    // The fixture's result names a session this client is not attached to, so
    // the row it asked for does not exist here. Scrolling anyway would move
    // the reader somewhere they did not ask to go.
    const pane = await withTui(async (tui) => {
        await tui.openSearch();
        tui.text("fallback");
        await tui.paneWhere((value) => value.includes("relay-gui"));
        tui.key("Enter");
        await Bun.sleep(500);
        return tui.pane();
    }, 100, 30);

    expect(pane).not.toContain("MATCHED");
}, 60_000);

test.skipIf(!tmuxAvailable)("an open tab keeps its ages true as time passes", async () => {
    const { before, after } = await withTui(async (tui) => {
        await tui.openWorkTab();
        const before = await tui.paneWhere((value) =>
            value.includes("auth-race"));
        // The host sends a new index only when the work changes, and a session
        // waiting on an answer never does. The row still has to stop saying
        // "2m ago" about something that happened three minutes ago.
        const after = await tui.paneWhere(
            (value) => /auth-race.*\b3m ago/.test(value),
            75_000,
        );
        return { before, after };
    });

    expect(before).toContain("2m ago");
    expect(after).toContain("3m ago");
}, 120_000);

test.skipIf(!tmuxAvailable)("a list longer than the card scrolls with the cursor", async () => {
    const { top, moved } = await withTui(async (tui) => {
        await tui.openWorkTab();
        const top = await tui.paneWhere((value) => value.includes("auth-race"));
        for (let press = 0; press < 25; press += 1) tui.key("Down");
        const moved = await tui.paneWhere((value) =>
            value.includes("> bulk-22"));
        return { top, moved };
    }, 100, 24, { VERA_TEST_MANY: "1" });

    // Nothing is cut off the top until the cursor has moved past it, and the
    // row under the cursor is always one the card is showing.
    expect(top).not.toContain("above");
    expect(top).toContain("> auth-race");
    expect(moved).toContain("above");
    expect(moved).toContain("> bulk-22");
}, 60_000);

test.skipIf(!tmuxAvailable)("the cursor walks every hit, not one per session", async () => {
    const { first, third } = await withTui(async (tui) => {
        await tui.openSearch();
        tui.text("fallback");
        const first = await tui.paneWhere((value) =>
            value.includes("> you: if the provider fallback"));
        tui.key("Down");
        tui.key("Down");
        const third = await tui.paneWhere((value) =>
            value.includes("> ran: bun test"));
        return { first, third };
    });

    // The third hit is the second one in its session, which a cursor that
    // stopped at sessions would leave on screen and unreachable.
    expect(first).toContain("> you: if the provider fallback");
    expect(third).toContain("> ran: bun test tests/unit/fallback");
    expect(third).not.toContain("> you: if the provider fallback");
}, 60_000);

test.skipIf(!tmuxAvailable)("the mouse reaches the rows the arrows reach", async () => {
    const { opened, hovered, wheeled } = await withTui(async (tui) => {
        await tui.openWorkTab();
        const opened = await tui.paneWhere((value) =>
            value.includes("> auth-race"));
        // The second row, counted down the pane the way a person points at it.
        tui.mouse("move", 20, 8);
        const hovered = await tui.paneWhere((value) =>
            value.includes("> browser-tests"));
        for (let notch = 0; notch < 5; notch += 1) tui.mouse("wheel", 20, 8);
        const wheeled = await tui.paneWhere((value) =>
            value.includes("> bulk-"));
        return { opened, hovered, wheeled };
    }, 100, 24, { VERA_TEST_MANY: "1" });

    expect(opened).toContain("> auth-race");
    // Hovering moves the cursor, so enter and a click always agree on what
    // they act on.
    expect(hovered).toContain("> browser-tests");
    expect(hovered).not.toContain("> auth-race");
    // The wheel moves the cursor rather than the window, so the card never
    // scrolls the selection out of sight.
    expect(wheeled).toContain("above");
    expect(wheeled).toMatch(/> bulk-\d/);
}, 60_000);

interface DrivenTui {
    pane(): string;
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
        }${quote(process.execPath)} run ${quote(CHILD)}`,
    ]);
    runTmux(socket, ["set-option", "-t", session, "monitor-bell", "on"], true);

    const pane = (): string =>
        runTmux(socket, ["capture-pane", "-p", "-t", session]).output;
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
            pane,
            paneWhere,
            text,
            key,
            bytes,
            mouse,
            bellRang,
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
    runTmux(socket, ["kill-server"], true);
}

function runTmux(
    socket: string,
    args: readonly string[],
    tolerant = false,
): { readonly ok: boolean; readonly output: string } {
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
