// What still runs under tmux, now that most of this suite drives the real TUI
// in-process against a virtual screen (test/tui/driven/, via
// test/support/tui-harness.ts):
//
// - Tests that span real processes or real panes: resident hosts, the CLI
//   attach flow, btw/pair sidekicks, and the two-pane participation loop.
// - Two in-process holdouts that segfault opentui 0.2.16's virtual renderer:
//   the sidebar split layout, and ctrl+c while a trash refresh is pending.
//
// A new TUI test belongs in test/tui/driven/ unless it needs one of the above.
import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
    ownTmuxServer,
    ownVeraHostLock,
} from "../support/uat-process-owner.ts";
import { killTmuxServer } from "../support/kill-tmux-server.ts";

function profileDirectory(home: string): string {
    return join(home, ".vera");
}

function runtimeDirectory(home: string): string {
    return join(profileDirectory(home), "runtime");
}

function createTuiHome(prefix: string): string {
    const home = mkdtempSync(join(tmpdir(), prefix));
    ownVeraHostLock(join(runtimeDirectory(home), "host.json"));
    return home;
}

const tmuxAvailable = canRunTmux();

test.skipIf(!tmuxAvailable)(
    "an extension opens a sidebar beside the transcript and closes it again",
    async () => {
        const socket = `vera-sidebar-${process.pid}-${randomUUID()}`;
        const session = "sidebar";
        const home = createTuiHome("vera-tui-sidebar-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-sidebar-child.ts",
                100,
                44,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/pane");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "beside the transcript",
            );
            // Both columns on one line: the split is a layout, not a takeover.
            expect(pane).toMatch(/Start a conversation.+m1 \(faux\)/);

            sendText(socket, session, "/unpane");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("beside the transcript"),
                "the sidebar to close",
            );
            expect(pane).not.toContain("m1 (faux)");

            sendText(socket, session, "/pane");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "beside the transcript");

            sendText(socket, session, "/reload-extensions");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Client extensions reloaded",
            );
            expect(pane).not.toContain("m1 (faux)");
            expect(readFileSync(
                join(home, "client-extensions-reloaded.txt"),
                "utf8",
            )).toBe("reloaded");

            sendText(socket, session, "/diagnostics");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "SESSION USAGE");
            sendKey(socket, session, "Tab");
            pane = await waitForVisiblePane(
                socket,
                session,
                "reload       success (1 loaded)",
            );
            expect(pane).toContain("active       test.sidebar");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("Diagnostics"),
                "diagnostics overlay to close",
            );

            sendText(socket, session, "/pane");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "beside the transcript",
            );
            expect(pane).toContain("m1 (faux)");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "session picker confirms and trashes one idle conversation",
    async () => {
        const socket = `vera-trash-${process.pid}-${randomUUID()}`;
        const session = "trash";
        const home = createTuiHome("vera-tui-trash-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-trash-session-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Continue the theme picker",
            );
            expect(pane).toContain("del trash");
            sendKey(socket, session, "DC");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Move conversation to Trash?",
            );
            sendKey(socket, session, "Enter");
            expect(captureVisiblePane(socket, session))
                .toContain("Move conversation to Trash?");
            sendText(socket, session, "1");
            sendKey(socket, session, "Enter");
            sendKey(socket, session, "C-c");
            expect(captureVisiblePane(socket, session))
                .toContain("Move conversation to Trash?");
            pane = await waitForVisiblePane(
                socket,
                session,
                "No conversations found",
            );
            sendKey(socket, session, "Escape");
            // The picker covers the transcript while it is open, so the notice
            // is read once the card is gone rather than from the margin beside
            // it.
            pane = await waitForVisiblePane(socket, session, "moved to");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(
                join(home, "trash-session-result.txt"),
                "utf8",
            )).toBe("saved-session");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

function startTuiSession(
    socket: string,
    session: string,
    home: string,
    childPath: string,
    width = 100,
    // One row taller than the transcript needs, because the pane header the
    // sidebar draws above it now takes a row of its own.
    height = 35,
    env: Readonly<Record<string, string>> = {},
): void {
    const exported = Object.entries(env)
        .map(([name, value]) => `${name}=${shellQuote(value)} `)
        .join("");
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
        `cd ${shellQuote(process.cwd())} && HOME=${
            shellQuote(home)
        } VERA_HOME=${shellQuote(join(home, ".vera"))} ${exported}exec ${shellQuote(process.execPath)} run ${
            shellQuote(childPath)
        }`,
    ]);
}

test.skipIf(!tmuxAvailable)(
    "real TUI rewinds through a separate resident host process",
    async () => {
        const socket = `vera-resident-flow-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = createTuiHome("vera-resident-flow-");
        const readyPath = join(home, "host-ready");
        let pane = "";
        const hostProcess = Bun.spawn([
            process.execPath,
            "run",
            "test/support/tui-rewind-resident-host.ts",
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: home,
                VERA_HOME: join(home, ".vera"),
                VERA_TEST_READY_PATH: readyPath,
            },
            stdout: "ignore",
            stderr: "pipe",
        });

        try {
            await waitForFile(readyPath, hostProcess);
            runTmux(socket, [
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "100",
                "-y",
                "30",
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach rewind-agent`,
            ]);
            pane = await exerciseConversationRewind(socket, session);
            expect(pane).not.toContain("Connection error");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            if (hostProcess.exitCode === null) {
                hostProcess.kill("SIGTERM");
            }
            await hostProcess.exited;
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "agent_roster identifies self and lists only the workspace's other session",
    async () => {
        const socket = `vera-roster-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = createTuiHome("vera-roster-");
        const readyPath = join(home, "host-ready");
        const manifestPath = join(home, "roster-manifest.json");
        let pane = "";
        const hostProcess = Bun.spawn([
            process.execPath,
            "run",
            "test/support/tui-roster-resident-host.ts",
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: home,
                VERA_HOME: join(home, ".vera"),
                VERA_TEST_READY_PATH: readyPath,
                VERA_TEST_MANIFEST_PATH: manifestPath,
            },
            stdout: "ignore",
            stderr: "pipe",
        });

        try {
            await waitForFile(readyPath, hostProcess);
            const manifest = JSON.parse(
                readFileSync(manifestPath, "utf8"),
            ) as Record<
                string,
                { name: string; session_path: string; updated_at: string }
            >;
            const caller = manifest["roster-caller"]!;
            const peer = manifest["roster-peer"]!;
            const stranger = manifest["roster-stranger"]!;

            runTmux(socket, [
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "100",
                "-y",
                "30",
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach roster-caller`,
            ]);
            await waitForPane(socket, session, "Start a conversation");
            sendText(socket, session, "who else is working here");
            sendKey(socket, session, "Enter");
            pane = await waitForPane(socket, session, "ROSTER");

            // The transcript hard-wraps long identifiers at the pane width, so
            // the assertions run against the pane with whitespace removed. The
            // scrollbar column goes too: it sits at the wrap boundary and would
            // otherwise land inside a wrapped path.
            const flat = pane.replaceAll(/[\s█]+/g, "");
            expect(flat).toContain('"self_participant_id":"roster-caller"');
            expect(flat).toContain('"participant_id":"roster-peer"');
            expect(flat).toContain(`"name":"${peer.name}"`);
            expect(flat).toContain('"status":"idle"');
            expect(flat).toContain('"live":true');
            expect(flat).not.toContain('"session_path"');
            expect(flat).not.toContain('"last_activity"');
            expect(flat).not.toContain('"participant_id":"roster-caller"');
            expect(flat).not.toContain(`"name":"${caller.name}"`);
            expect(flat).not.toContain('"participant_id":"roster-stranger"');
            expect(flat).not.toContain(`"name":"${stranger.name}"`);
            expect(pane).not.toContain("Connection error");
        } catch (error) {
            pane = capturePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            if (hostProcess.exitCode === null) {
                hostProcess.kill("SIGTERM");
            }
            await hostProcess.exited;
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);

test.skipIf(!tmuxAvailable)(
    "two native TUI panes complete the explicit local participation loop",
    async () => {
        const socket = `vera-local-loop-${process.pid}-${randomUUID()}`;
        const session = "participants";
        const leftPane = `${session}:0.0`;
        const rightPane = `${session}:0.1`;
        const home = createTuiHome("vera-local-loop-");
        const readyPath = join(home, "host-ready");
        let panes = "";
        const hostProcess = Bun.spawn([
            process.execPath,
            "run",
            "test/support/tui-local-participation-resident-host.ts",
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: home,
                VERA_HOME: join(home, ".vera"),
                VERA_TEST_READY_PATH: readyPath,
            },
            stdout: "ignore",
            stderr: "pipe",
        });

        try {
            await waitForFile(readyPath, hostProcess);
            runTmux(socket, [
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "160",
                "-y",
                "36",
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach left`,
            ]);
            runTmux(socket, [
                "split-window",
                "-h",
                "-t",
                leftPane,
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach right`,
            ]);
            await Promise.all([
                waitForPane(socket, leftPane, "Start a conversation"),
                waitForPane(socket, rightPane, "Start a conversation"),
            ]);

            sendText(socket, leftPane, "Question context from left");
            sendKey(socket, leftPane, "Enter");
            await waitForPane(socket, leftPane, "LEFT SENT");
            const unread = await waitForPane(
                socket,
                rightPane,
                "1 unread inbox entry",
            );
            expect(unread).not.toContain("acknowledgement ordering");
            expect(unread).not.toContain("Question context from left");

            sendText(socket, rightPane, "Read and answer the pending inbox");
            sendKey(socket, rightPane, "Enter");
            await waitForPane(socket, rightPane, "RIGHT REPLIED");
            await waitForPane(socket, leftPane, "unread inbox");

            sendText(socket, leftPane, "Read the receipt and reply");
            sendKey(socket, leftPane, "Enter");
            const completed = await waitForPane(
                socket,
                leftPane,
                "LEFT READ REPLY Use serialized acknowledgement.",
            );
            expect(completed).not.toContain("Connection error");
        } catch (error) {
            panes = `LEFT:\n${capturePane(socket, leftPane)}\nRIGHT:\n${
                capturePane(socket, rightPane)
            }`;
            throw new Error(`${errorMessage(error)}\n\nLast panes:\n${panes}`);
        } finally {
            killTmuxServer(socket);
            if (hostProcess.exitCode === null) hostProcess.kill("SIGTERM");
            await hostProcess.exited;
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);

test.skipIf(!tmuxAvailable)(
    "real TUI opens rewind through a detached resident host",
    async () => {
        const socket = `vera-resident-rewind-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = createTuiHome("vera-resident-rewind-");
        let pane = "";
        mkdirSync(profileDirectory(home), { recursive: true });
        writeFileSync(join(profileDirectory(home), "config.json"), `${JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        })}\n`);

        try {
            runTmux(socket, [
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "100",
                "-y",
                "30",
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts`,
            ]);
            await waitForPane(socket, session, "Start a conversation");
            sendText(socket, session, "/rew");
            sendKey(socket, session, "Tab");
            sendKey(socket, session, "Enter");
            pane = await waitForPane(
                socket,
                session,
                "No matching user messages.",
            );
            expect(pane).not.toContain("Connection error");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            await stopTemporaryHost(home);
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "btw and pair expose working focus, layout, and green rail controls",
    async () => {
        const socket = `vera-btw-controls-${process.pid}-${randomUUID()}`;
        const session = "btw-controls";
        const home = createTuiHome("vera-btw-controls-");
        let pane = "";

        const greenRail = /\x1b\[(?:38;2;34;197;94|38;5;41)m(?:\x1b\[[\d;]+m)*━+/;
        const railWidth = (visible: string): number =>
            visible.split("\n")
                .flatMap((line) => line.match(/━+/g) ?? [])
                .reduce((largest, run) => Math.max(largest, run.length), 0);

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                120,
                35,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/btw");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("btw mode · split")
                    && visible.includes("Message sidekick")
                    && visible.includes("sidekick · readonly"),
                "BTW split view",
            );
            expect(railWidth(pane)).toBeGreaterThan(0);
            const modeRow = pane.indexOf("btw mode · split");
            const composerRow = pane.indexOf("Message sidekick");
            const veraHeader = pane.indexOf("Vera · auto");
            const sidekickHeader = pane.indexOf("sidekick · readonly");
            expect(modeRow).toBeGreaterThan(veraHeader);
            expect(modeRow).toBeGreaterThan(composerRow);
            expect(pane).toContain(
                "ready · ctrl+p commands · btw mode · split",
            );
            expect(veraHeader).toBeGreaterThanOrEqual(0);
            expect(sidekickHeader).toBeGreaterThanOrEqual(0);
            expect(pane).not.toContain("|   sidekick · readonly");
            expect(captureVisiblePaneWithStyles(socket, session)).toMatch(greenRail);

            sendText(socket, session, "milestone working footer");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "esc stop sidekick",
            );
            const hostedWorkingLines = pane.split("\n");
            const hostedActivityRow = hostedWorkingLines.find((line) =>
                line.includes("esc stop sidekick")
            );
            const hostedPlaceRow = hostedWorkingLines.find((line) =>
                line.includes("ready · ctrl+p commands · btw mode · split")
            );
            expect(hostedActivityRow).toBeDefined();
            expect(hostedPlaceRow).toBeDefined();
            expect(pane).not.toContain("enter queue");
            if (
                hostedActivityRow === undefined
                || hostedPlaceRow === undefined
            ) {
                throw new Error("missing hosted activity or place row");
            }
            expect(hostedWorkingLines.indexOf(hostedActivityRow)).toBeLessThan(
                hostedWorkingLines.indexOf(hostedPlaceRow),
            );
            await waitForVisiblePane(socket, session, "SIDEKICK ANSWERED 1");

            sendKey(socket, session, "C-g");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && visible.includes("ctrl+g sidekick"),
                "Ctrl+G to focus Vera",
            );
            expect(railWidth(pane)).toBeGreaterThan(0);
            expect(captureVisiblePaneWithStyles(socket, session)).toMatch(greenRail);

            sendEscapeSequence(socket, session, String.fromCharCode(28));
            pane = await waitForVisiblePane(socket, session, "btw mode · btw only");
            expect(pane).toContain("Message sidekick");
            expect(railWidth(pane)).toBe(0);

            sendEscapeSequence(socket, session, String.fromCharCode(28));
            await waitForVisiblePane(socket, session, "btw mode · vera only");
            sendEscapeSequence(socket, session, String.fromCharCode(28));
            await waitForVisiblePane(socket, session, "btw mode · split");

            sendText(socket, session, "/pair");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("pair mode · split")
                    && visible.includes("Message peer")
                    && visible.includes("peer · ask"),
                "Pair split view",
            );
            expect(railWidth(pane)).toBeGreaterThan(0);
            expect(captureVisiblePaneWithStyles(socket, session)).toMatch(greenRail);

            sendKey(socket, session, "C-g");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && visible.includes("ctrl+g peer"),
                "Ctrl+G to focus Vera from Pair",
            );
            expect(railWidth(pane)).toBeGreaterThan(0);
            expect(captureVisiblePaneWithStyles(socket, session)).toMatch(greenRail);

            sendEscapeSequence(socket, session, String.fromCharCode(28));
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("pair mode · pair only")
                    && visible.includes("Message peer"),
                "Pair-only composer target",
            );
            expect(railWidth(pane)).toBe(0);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);


test.skipIf(!tmuxAvailable)(
    "btw opens a hosted sidekick and routes only among the visible agents",
    async () => {
        const socket = `vera-btw-hosted-${process.pid}-${randomUUID()}`;
        const session = "btw-hosted";
        const home = createTuiHome("vera-btw-hosted-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/bt");
            await waitForVisiblePane(
                socket,
                session,
                "Open or message a readonly sidekick",
            );
            sendText(socket, session, "w");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Message sidekick");
            sendText(socket, session, "inspect this");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "SIDEKICK ANSWERED 1",
            );
            expect(pane).toContain("inspect this");
            expect(pane).not.toContain("AGENT ANSWERED 1");
            expect(pane).toContain("readonly");
            expect(pane).toContain("Message sidekick");

            sendKey(socket, session, "C-f");
            pane = await waitForVisiblePane(socket, session, "this conversation");
            sendText(socket, session, "scope");
            pane = await waitForVisiblePane(socket, session, "SEARCH side-");
            expect(pane).not.toContain("SEARCH main-1");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message sidekick")
                    && !visible.includes("Search ·"),
                "search closed with sidekick focus",
            );

            sendText(socket, session, "/");
            await waitForVisiblePane(
                socket,
                session,
                "Rewind the active conversation",
            );
            sendKey(socket, session, "C-c");

            // Ctrl+G switches focus without making terminal selection and
            // pointer-capture behaviour part of message routing.
            sendKey(socket, session, "C-g");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Vera · auto"),
                "ctrl+g to focus the main agent",
            );
            sendKey(socket, session, "C-g");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("sidekick · readonly"),
                "ctrl+g to restore sidekick focus",
            );
            expect(captureVisiblePaneWithStyles(socket, session)).toMatch(
                /\x1b\[(?:38;2;34;197;94|38;5;41)m(?:\x1b\[[\d;]+m)*(?:▁|━)+/,
            );
            sendEscapeSequence(socket, session, String.fromCharCode(31));
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("btw mode")
                    && visible.includes("btw only")
                    && !visible.includes("Start a conversation with Vera"),
                "ctrl+/ to show only the sidekick",
            );
            expect(pane).toContain("SIDEKICK ANSWERED 1");
            expect(pane).toContain("Message sidekick");
            expect(pane).toContain("sidekick · readonly");
            sendEscapeSequence(socket, session, String.fromCharCode(31));
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("vera only")
                    && !visible.includes("SIDEKICK ANSWERED 1"),
                "ctrl+/ to show only Vera",
            );
            expect(pane).toContain("Message Vera");
            expect(pane).toContain("Vera · auto");
            sendText(socket, session, "main after layout switch");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED 1");
            expect(pane).toContain("main after layout switch");
            sendEscapeSequence(socket, session, String.fromCharCode(31));
            await waitForVisiblePane(socket, session, "SIDEKICK ANSWERED 1");
            sendKey(socket, session, "C-g");

            // `/btw` focuses the attached pane, so a bare follow-up stays in
            // the hosted sidekick without an extension interceptor.
            sendText(socket, session, "follow up");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "SIDEKICK ANSWERED 2",
            );

            sendText(socket, session, "/effort low");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "test · LOW",
            );

            sendText(socket, session, "/permissions ask");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("sidekick · ask"),
                "the focused sidekick permission mode to change",
            );

            // A bare visible mention changes focus without sending a turn.
            sendText(socket, session, "@vera");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Vera · auto")
                    && visible.includes("test · HIGH"),
                "the main agent permission mode after focus changes",
            );
            expect(pane).toContain("test · HIGH");
            sendText(socket, session, "main only");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "AGENT ANSWERED 1",
            );
            expect(pane).not.toContain("SIDEKICK ANSWERED 3");

            sendText(socket, session, "@all compare");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "SIDEKICK ANSWERED 3",
            );
            expect(pane).toContain("AGENT ANSWERED 2");

            sendText(socket, session, "@sidekick");
            sendKey(socket, session, "Enter");
            sendText(socket, session, "/subagents");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "child-1");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Message child-1");
            sendText(socket, session, "child question");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "CHILD ANSWERED 1",
            );
            expect(pane).not.toContain("SIDEKICK ANSWERED 4");

            // Replacing the sidebar detached the sidekick but did not stop
            // its hosted session; `/btw` can attach and continue it again.
            sendText(socket, session, "/btw back again");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "SIDEKICK ANSWERED 4");

            sendText(socket, session, "request approval");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Allow once");
            expect(pane).toContain("$ printf approved");
            sendKey(socket, session, "1");
            pane = await waitForVisiblePane(
                socket,
                session,
                "SIDEKICK ANSWERED 6",
            );
            expect(pane).not.toContain("tool header");
            expect(pane).not.toMatch(/^\s+(?:tool|thought|agent|you)\s*$/m);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skipIf(!tmuxAvailable)(
    "btw and direct addressing send images through the sidekick session",
    async () => {
        const socket = `vera-btw-image-${process.pid}-${randomUUID()}`;
        const session = "btw-image";
        const home = createTuiHome("vera-btw-image-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw ");
            sendEscapeSequence(
                socket,
                session,
                "\x1b[200~/tmp/screenshot.png\x1b[201~",
            );
            await waitForVisiblePane(socket, session, "1 image attached");
            sendText(socket, session, "what do you see");
            sendKey(socket, session, "Enter");

            pane = await waitForVisiblePane(
                socket,
                session,
                "SIDEKICK SAW IMAGE 1",
            );
            expect(pane).toContain("screenshot.png");
            expect(pane).not.toContain("AGENT ANSWERED");

            sendKey(socket, session, "C-g");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Vera · auto"),
                "main agent focus",
            );
            sendText(socket, session, "@sidekick ");
            sendEscapeSequence(
                socket,
                session,
                "\x1b[200~/tmp/second.png\x1b[201~",
            );
            await waitForVisiblePane(socket, session, "1 image attached");
            sendText(socket, session, "and this one");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "SIDEKICK SAW IMAGE 2",
            );
            expect(pane).toContain("and this one");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);

test.skipIf(!tmuxAvailable)(
    "pair opens a tool-capable peer and shows its effective mode",
    async () => {
        const socket = `vera-pair-hosted-${process.pid}-${randomUUID()}`;
        const session = "pair-hosted";
        const home = createTuiHome("vera-pair-hosted-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/pair inspect this");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "PEER ANSWERED 1");
            expect(pane).toContain("peer · ask");
            expect(pane).not.toContain("AGENT ANSWERED 1");

            sendText(socket, session, "ask from peer");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Answer the peer?");
            expect(pane).toContain("Yes");
            expect(pane).toContain("No");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "PEER ANSWERED 3");

            sendText(socket, session, "/rename peer research");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "session renamed: peer research");
            expect(pane).toContain("peer research · ask");

            // Conversations live in /resume (ctrl+e). Rename the peer from that
            // picker so the host sees this TUI's companion attachment.
            sendKey(socket, session, "C-e");
            pane = await waitForVisiblePane(socket, session, "Resume");
            sendText(socket, session, "peer research");
            pane = await waitForVisiblePane(socket, session, "peer research");
            sendKey(socket, session, "C-r");
            await waitForVisiblePane(socket, session, "Rename conversation");
            for (const _character of "peer research") {
                sendKey(socket, session, "BSpace");
            }
            sendText(socket, session, "peer from rail");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("peer from rail")
                    && visible.includes("Resume")
                    && !visible.includes("Rename conversation"),
                "the peer renamed in the conversation list",
            );
            sendKey(socket, session, "Escape");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("peer from rail · ask")
                    && !visible.includes("Resume"),
                "the renamed peer after the conversation list closes",
            );

            sendText(socket, session, "/permissions readonly");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "peer from rail · readonly",
            );

            sendText(socket, session, "/clear");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Close this conversation");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Message peer");
            sendText(socket, session, "fresh peer");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "PEER ANSWERED 1");
            expect(pane).not.toContain("inspect this");

            sendText(socket, session, "/pair close");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Message Vera");
            expect(pane).not.toContain("Message peer");

            sendKey(socket, session, "C-g");
            sendText(socket, session, "main only");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED 1");
            expect(pane).not.toContain("PEER ANSWERED 2");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);

// Superseded consult-lane acceptance remains skipped until its large fixtures
// are deleted with the rest of the old Party vocabulary below.
test.skip(
    "a seated model answers in its own column, and its note stays off the band",
    async () => {
        const socket = `vera-advisor-${process.pid}-${randomUUID()}`;
        const session = "advisor";
        const home = createTuiHome("vera-advisor-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            // The pool owns the list the argument completes from.
            sendText(socket, session, "/btw ");
            pane = await waitForVisiblePane(socket, session, "guest");

            sendText(socket, session, "guest");
            sendKey(socket, session, "Enter");
            // Seating fills the column before the seat has said anything.
            pane = await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");
            expect(pane).toContain("sidekick (faux-guest)");

            // An addressed message goes to the seat alone: the ask and the
            // answer are filed beside the transcript, not in it.
            sendText(socket, session, "@sidekick which ordering");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SEAT SAW");
            expect(pane).toContain("you \u2192 @sidekick");

            // The next message to the agent carries the user's words alone:
            // nothing the seat said crosses on its own.
            sendText(socket, session, "go on");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED");
            expect(pane).toContain("go on");
            expect(pane).not.toContain("system-note");
            expect(pane).not.toContain("joined this conversation");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skipIf(!tmuxAvailable)(
    "a sidekick catches up on the primary conversation before it answers",
    async () => {
        const socket = `vera-btw-context-${process.pid}-${randomUUID()}`;
        const session = "btw-context";
        const home = createTuiHome("vera-btw-context-");
        const readyPath = join(home, "host-ready");
        let pane = "";
        mkdirSync(profileDirectory(home), { recursive: true });
        writeFileSync(join(profileDirectory(home), "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            extensions: [{
                path: join(process.cwd(), "extensions/btw"),
                enabled: true,
            }],
        }));
        const hostProcess = Bun.spawn([
            process.execPath,
            "run",
            "test/support/tui-btw-context-resident-host.ts",
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: home,
                VERA_HOME: join(home, ".vera"),
                VERA_TEST_READY_PATH: readyPath,
            },
            stdout: "ignore",
            stderr: "pipe",
        });

        const attach = (): void => {
            runTmux(socket, [
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "120",
                "-y",
                "40",
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach btw-main`,
            ]);
        };
        // The side pane is narrow, so the notice wraps: match its first line.
        const caughtUp = "Caught up with 1 new turn from the";
        const occurrences = (visible: string, needle: string): number =>
            visible.split(needle).length - 1;

        try {
            await waitForFile(readyPath, hostProcess);
            attach();
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "P1");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "SEEN:P1");

            sendText(socket, session, "/btw");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "sidekick · readonly");
            // Inherited history belongs to the model, not to the side pane.
            expect(occurrences(pane, "SEEN:P1")).toBe(1);

            sendText(socket, session, "S1");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SEEN:P1,S1");
            expect(pane).not.toContain(caughtUp);

            sendKey(socket, session, "C-g");
            await waitForVisiblePane(socket, session, "Message Vera");
            sendText(socket, session, "P2");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "SEEN:P1,P2");

            sendKey(socket, session, "C-g");
            await waitForVisiblePane(socket, session, "Message sidekick");
            sendText(socket, session, "S2");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SEEN:P1,S1,P2,S2");
            pane = await waitForVisiblePane(socket, session, caughtUp);
            expect(occurrences(pane, caughtUp)).toBe(1);
            expect(pane.indexOf(caughtUp)).toBeGreaterThan(pane.indexOf("S2"));
            expect(pane.indexOf(caughtUp))
                .toBeLessThan(pane.indexOf("SEEN:P1,S1,P2,S2"));
            // The hidden boundary never reaches the pane or the answer.
            expect(pane).not.toContain("side conversation");
            expect(pane).not.toContain("inherited history");

            // A side turn with nothing new on the primary neither repeats the
            // notice nor loses it across the history rebuilds it causes.
            sendText(socket, session, "S3");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SEEN:P1,S1,P2,S2,S3");
            expect(occurrences(pane, caughtUp)).toBe(1);
            expect(pane.indexOf(caughtUp)).toBeLessThan(pane.indexOf("S3"));
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            if (hostProcess.exitCode === null) hostProcess.kill("SIGTERM");
            await hostProcess.exited;
            rmSync(home, { recursive: true, force: true });
        }
    },
    45_000,
);

test.skipIf(!tmuxAvailable)(
    "a durable pair pane returns after the TUI reconnects",
    async () => {
        const socket = `vera-pair-persist-${process.pid}-${randomUUID()}`;
        const session = "pair-persist";
        const home = createTuiHome("vera-pair-persist-");
        const readyPath = join(home, "host-ready");
        const preferencePath = join(profileDirectory(home), "tui.json");
        let pane = "";
        mkdirSync(profileDirectory(home), { recursive: true });
        writeFileSync(join(profileDirectory(home), "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            extensions: [{
                path: join(process.cwd(), "extensions/btw"),
                enabled: true,
            }],
        }));
        const hostProcess = Bun.spawn([
            process.execPath,
            "run",
            "test/support/tui-pair-persistence-resident-host.ts",
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: home,
                VERA_HOME: join(home, ".vera"),
                VERA_TEST_READY_PATH: readyPath,
            },
            stdout: "ignore",
            stderr: "pipe",
        });

        const attach = (): void => {
            runTmux(socket, [
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "100",
                "-y",
                "30",
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} exec ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach pair-main`,
            ]);
        };

        try {
            await waitForFile(readyPath, hostProcess);
            attach();
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/pair first pass");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "PAIR ANSWERED");
            expect(pane).toContain("peer · ask");

            const persisted = JSON.parse(readFileSync(preferencePath, "utf8"));
            const savedPane = persisted.persisted_agent_panes?.find(
                (candidate: any) => candidate.main_agent_id === "pair-main",
            );
            const peerId = savedPane?.sidebar_agent_id;
            expect(peerId).toBeString();
            expect(savedPane).toMatchObject({
                main_agent_id: "pair-main",
                owner: "vera.btw",
                mention: "peer",
            });

            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            attach();
            pane = await waitForVisiblePane(socket, session, "peer · ask");

            sendText(socket, session, "/pair second pass");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "PAIR ANSWERED");
            const restored = JSON.parse(readFileSync(preferencePath, "utf8"));
            const restoredPane = restored.persisted_agent_panes?.find(
                (candidate: any) => candidate.main_agent_id === "pair-main",
            );
            expect(restoredPane?.sidebar_agent_id).toBe(peerId);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            if (hostProcess.exitCode === null) hostProcess.kill("SIGTERM");
            await hostProcess.exited;
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "a new conversation takes the sidebar and the sidekick with it",
    async () => {
        const socket = `vera-seat-clear-${process.pid}-${randomUUID()}`;
        const session = "seat-clear";
        const home = createTuiHome("vera-seat-clear-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw guest");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "/clear");
            await Bun.sleep(300);
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Close this conversation");
            sendKey(socket, session, "Enter");
            // The column belonged to the conversation being left, and so did
            // the seat: an alias that answers nowhere is worse than no alias.
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) =>
                    visible.includes("Start a conversation")
                    && !visible.includes("faux-guest"),
                "an empty conversation with no sidebar",
            );

            sendText(socket, session, "@sidekick anyone home");
            sendKey(socket, session, "Enter");
            // Nothing intercepts it now, so it reaches the agent as typed.
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED");
            expect(pane).toContain("@sidekick anyone home");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "@all reaches the sidekick and the agent in one message",
    async () => {
        const socket = `vera-seat-all-${process.pid}-${randomUUID()}`;
        const session = "seat-all";
        const home = createTuiHome("vera-seat-all-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw guest");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "@all which ordering");
            sendKey(socket, session, "Enter");
            // The sidekick answers in the column and the agent answers in the
            // transcript: `@all` is both of them, not only the seat.
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED");
            expect(pane).toContain("sidekick (faux-guest)");
            // What the agent was sent is not what the band shows.
            expect(pane).toContain("which ordering");
            expect(pane).not.toContain("system-note");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "removing the sidekick says so in its column",
    async () => {
        const socket = `vera-seat-remove-${process.pid}-${randomUUID()}`;
        const session = "seat-remove";
        const home = createTuiHome("vera-seat-remove-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/btw guest");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "/res");
            pane = await waitForVisiblePane(socket, session, "/reset");
            expect(pane).toContain("/resume");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("/reset"),
                "the seated command list to close",
            );

            // There is one seat, so freeing it needs no name.
            sendText(socket, session, "/rem");
            pane = await waitForVisiblePane(socket, session, "/remove");
            sendKey(socket, session, "Enter");
            // The column goes with the seat, so the notice is what says so.
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) =>
                    visible.includes("@sidekick left")
                    && !visible.includes("Seated. Ask with @sidekick"),
                "the sidekick gone and its column with it",
            );

            sendText(socket, session, "/res");
            pane = await waitForVisiblePane(socket, session, "/resume");
            expect(pane).not.toContain("/reset");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("/resume"),
                "the resume command list to close",
            );
            sendText(socket, session, "/remo");
            pane = await waitForVisiblePane(socket, session, "/remo");
            expect(pane).not.toContain("/remove");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "the agent is not told that a seat left",
    async () => {
        const socket = `vera-seat-left-${process.pid}-${randomUUID()}`;
        const session = "seat-left";
        const home = createTuiHome("vera-seat-left-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw guest");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "/remove");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "@sidekick left");

            sendText(socket, session, "is it just us");
            sendKey(socket, session, "Enter");
            // One way both ways: the agent is never told who sat down or got
            // up, so the faux agent, which answers with what it was sent, sees
            // the user's words and nothing else.
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED");
            expect(pane).toContain("is it just us");
            expect(pane).not.toContain("system-note");
            expect(pane).not.toContain("AGENT SAW A SEAT LEAVE");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "a selection arms the next message once there is somewhere to send it",
    async () => {
        const socket = `vera-seat-quote-${process.pid}-${randomUUID()}`;
        const session = "seat-quote";
        const home = createTuiHome("vera-seat-quote-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw guest");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "which ordering");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED");

            const lines = pane.split("\n");
            const row = lines.findIndex((line) =>
                line.includes("AGENT ANSWERED")
            );
            const line = lines[row];
            if (line === undefined) {
                throw new Error("The agent's answer was not visible");
            }
            const column = line.indexOf("AGENT ANSWERED");
            sendMouseDrag(
                socket,
                session,
                column + 1,
                row + 1,
                column + "AGENT ANSWERED".length + 1,
                row + 1,
            );
            // Someone is seated, so the selection is both a copy and the
            // start of the next message.
            pane = await waitForVisiblePane(socket, session, "quoting agent");
            expect(pane).toContain("esc clears it");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "a held address stays in view when the transcript scrolls away",
    async () => {
        const socket = `vera-seat-held-${process.pid}-${randomUUID()}`;
        const session = "seat-held";
        const home = createTuiHome("vera-seat-held-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw guest");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "@sidekick");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "every message goes to @sidekick",
            );
            expect(pane).toContain("@vera goes back to the agent");

            // Where the messages are going is a mode, and a mode has to be
            // readable for as long as it lasts: scrolled back through the
            // transcript, the line is still above the composer.
            sendMouseWheel(socket, session, "up", 20, 4, 20);
            await Bun.sleep(300);
            pane = capturePane(socket, session);
            expect(pane).toContain("every message goes to @sidekick");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skip(
    "a seat that cannot answer says so where its answer would have been",
    async () => {
        const socket = `vera-seat-failure-${process.pid}-${randomUUID()}`;
        const session = "seat-failure";
        const home = createTuiHome("vera-seat-failure-");
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-btw-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/btw broken");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @sidekick");

            sendText(socket, session, "@sidekick you there");
            sendKey(socket, session, "Enter");
            // In the column, under the seat's own label: a failed round is a
            // gap in that conversation, not a notice about somewhere else.
            pane = await waitForVisiblePane(socket, session, "Could not answer");
            expect(pane).toContain("you \u2192 @sidekick");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            killTmuxServer(socket);
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

function sendText(socket: string, session: string, value: string): void {
    runTmux(socket, ["send-keys", "-t", session, "-l", value]);
}

function sendKey(socket: string, session: string, key: string): void {
    runTmux(socket, ["send-keys", "-t", session, key]);
}

function sendEscapeSequence(
    socket: string,
    session: string,
    sequence: string,
): void {
    runTmux(socket, [
        "send-keys",
        "-t",
        session,
        "-H",
        ...Array.from(Buffer.from(sequence), (byte) =>
            byte.toString(16).padStart(2, "0")
        ),
    ]);
}

function sendMouseWheel(
    socket: string,
    session: string,
    direction: "up" | "down",
    x: number,
    y: number,
    times = 1,
): void {
    const button = direction === "up" ? 64 : 65;
    const sequence = `\x1b[<${button};${x};${y}M`.repeat(times);
    runTmux(socket, [
        "send-keys",
        "-t",
        session,
        "-H",
        ...Array.from(Buffer.from(sequence), (byte) =>
            byte.toString(16).padStart(2, "0")
        ),
    ]);
}

function sendMouseDrag(
    socket: string,
    session: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
): void {
    const sequence = `\x1b[<0;${startX};${startY}M`
        + `\x1b[<32;${endX};${endY}M`
        + `\x1b[<0;${endX};${endY}m`;
    runTmux(socket, [
        "send-keys",
        "-t",
        session,
        "-H",
        ...Array.from(Buffer.from(sequence), (byte) =>
            byte.toString(16).padStart(2, "0")
        ),
    ]);
}

async function exerciseConversationRewind(
    socket: string,
    session: string,
): Promise<string> {
    await waitForPane(socket, session, "Start a conversation");
    sendText(socket, session, "first request");
    sendKey(socket, session, "Enter");
    await waitForPane(socket, session, "FIRST ANSWER");
    sendText(socket, session, "second request");
    sendKey(socket, session, "Enter");
    await waitForPane(socket, session, "SECOND ANSWER");

    sendText(socket, session, "/rew");
    // Description padding is computed over the matching commands, so once the
    // filter settles on one row there is nothing to pad to. The wide form this
    // used to expect is the unfiltered list, which is only on screen for the
    // instant between "/" and "rew" being typed.
    let pane = await waitForPane(
        socket,
        session,
        "/rewind  Rewind the active conversation",
    );
    sendKey(socket, session, "Tab");
    pane = await waitForPaneWhere(
        socket,
        session,
        (current) => occurrences(current, "/rewind") >= 2,
        "completed /rewind command",
    );
    sendKey(socket, session, "Enter");
    pane = await waitForPaneWhere(
        socket,
        session,
        // The transcript behind the overlay also carries "second request", so
        // the timeline has only loaded once its own footer is on screen.
        (current) => current.includes("Rewind: select a point")
            && current.includes(
                "Workspace files and external effects will not change",
            ),
        "loaded rewind timeline",
    );
    expect(pane).toContain("Rewind: select a point");
    expect(pane).toContain("second request");
    expect(pane).toContain(
        "Workspace files and external effects will not change",
    );

    sendKey(socket, session, "Enter");
    await waitForPane(socket, session, "Rewind conversation");
    sendText(socket, session, "1");
    pane = await waitForPane(socket, session, "Confirm rewind");
    expect(pane).toContain("Files         unchanged");
    expect(pane).toContain("External work unchanged");

    sendKey(socket, session, "Enter");
    pane = await waitForPaneWhere(
        socket,
        session,
        (current) => current.includes("FIRST ANSWER")
            && !current.includes("SECOND ANSWER")
            && !current.includes("Confirm rewind"),
        "rewound transcript",
    );
    expect(pane).toContain("first request");
    expect(occurrences(pane, "second request")).toBe(1);
    return pane;
}

async function waitForFile(
    path: string,
    process: { readonly exitCode: number | null },
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            return;
        }
        if (process.exitCode !== null) {
            throw new Error(
                `Resident host exited before ready with code ${process.exitCode}`,
            );
        }
        await Bun.sleep(50);
    }
    throw new Error("Timed out waiting for resident host");
}

async function waitForPane(
    socket: string,
    session: string,
    expected: string,
): Promise<string> {
    const deadline = Date.now() + 5_000;
    let pane = "";

    while (Date.now() < deadline) {
        pane = capturePane(socket, session);
        if (pane.includes(expected)) {
            return pane;
        }
        await Bun.sleep(50);
    }

    throw new Error(`Timed out waiting for ${JSON.stringify(expected)}`);
}

async function waitForPaneWhere(
    socket: string,
    session: string,
    predicate: (pane: string) => boolean,
    description: string,
): Promise<string> {
    const deadline = Date.now() + 5_000;
    let pane = "";

    while (Date.now() < deadline) {
        pane = capturePane(socket, session);
        if (predicate(pane)) {
            return pane;
        }
        await Bun.sleep(50);
    }

    throw new Error(`Timed out waiting for ${description}`);
}

async function waitForVisiblePane(
    socket: string,
    session: string,
    expected: string,
): Promise<string> {
    return waitForVisiblePaneWhere(
        socket,
        session,
        (pane) => pane.includes(expected),
        JSON.stringify(expected),
    );
}

async function waitForVisiblePaneWhere(
    socket: string,
    session: string,
    predicate: (pane: string) => boolean,
    description: string,
): Promise<string> {
    const deadline = Date.now() + 5_000;
    let pane = "";

    while (Date.now() < deadline) {
        pane = captureVisiblePane(socket, session);
        if (predicate(pane)) {
            return pane;
        }
        await Bun.sleep(50);
    }

    throw new Error(`Timed out waiting for visible ${description}`);
}

async function waitForSessionExit(
    socket: string,
    session: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = Bun.spawnSync([
            "tmux",
            "-L",
            socket,
            "has-session",
            "-t",
            session,
        ], {
            stdout: "ignore",
            stderr: "ignore",
        });
        if (result.exitCode !== 0) {
            return;
        }
        await Bun.sleep(50);
    }
    throw new Error("Timed out waiting for TUI to exit");
}

function capturePane(socket: string, session: string): string {
    return runTmux(socket, [
        "capture-pane",
        "-p",
        "-t",
        session,
        "-S",
        "-",
    ]);
}

function captureVisiblePane(socket: string, session: string): string {
    return runTmux(socket, ["capture-pane", "-p", "-t", session]);
}

function captureVisiblePaneWithStyles(
    socket: string,
    session: string,
): string {
    return runTmux(socket, ["capture-pane", "-p", "-e", "-t", session]);
}

function runTmux(socket: string, args: readonly string[]): string {
    if (args.includes("new-session")) ownTmuxServer(socket);
    const result = Bun.spawnSync(["tmux", "-L", socket, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(`tmux ${args[0]} failed: ${stderr || stdout.trim()}`);
    }
    return stdout;
}

function canRunTmux(): boolean {
    const socket = `vera-probe-${process.pid}-${randomUUID()}`;
    const result = Bun.spawnSync([
        "tmux",
        "-L",
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "probe",
        "sleep 1",
    ], {
        stdout: "ignore",
        stderr: "ignore",
    });
    const session = Bun.spawnSync([
        "tmux",
        "-L",
        socket,
        "has-session",
        "-t",
        "probe",
    ], {
        stdout: "ignore",
        stderr: "ignore",
    });
    killTmuxServer(socket);
    return result.exitCode === 0 && session.exitCode === 0;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function occurrences(text: string, value: string): number {
    return text.split(value).length - 1;
}

async function stopTemporaryHost(home: string): Promise<void> {
    let record: { readonly pid?: unknown };
    try {
        record = JSON.parse(
            readFileSync(join(runtimeDirectory(home), "host.json"), "utf8"),
        ) as { readonly pid?: unknown };
    } catch {
        return;
    }
    if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
        return;
    }
    const pid = record.pid as number;
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error(`Temporary resident host ${pid} did not stop`);
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
