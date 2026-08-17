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

function profileDirectory(home: string): string {
    return join(home, ".vera", "profiles", "default");
}

function runtimeDirectory(home: string): string {
    return join(profileDirectory(home), "runtime");
}

const tmuxAvailable = canRunTmux();

test.skipIf(!tmuxAvailable)(
    "ctrl+c clears an idle draft before it quits",
    async () => {
        const socket = `vera-draft-interrupt-${process.pid}-${randomUUID()}`;
        const session = "draft-interrupt";
        const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "keep me from quitting");
            pane = await waitForVisiblePane(
                socket,
                session,
                "keep me from quitting",
            );

            sendKey(socket, session, "C-c");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && !visible.includes("keep me from quitting"),
                "ctrl+c to clear the draft without quitting",
            );
            expect(pane).toContain("ready");

            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "diagnostics opens as a large copyable overlay instead of transcript text",
    async () => {
        const socket = `vera-diagnostics-${process.pid}-${randomUUID()}`;
        const session = "diagnostics";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-diagnostics-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-child.ts",
                100,
                36,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/diagnostics");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "copy  enter");
            expect(pane).toContain("Extensions");
            expect(pane).toContain("Runtime");
            expect(pane).toContain("copy  enter");
            // The composer stays behind the overlay, and its frame carries the
            // row that says what the session is answering as.
            expect(pane).toContain("test · HIGH");

            sendKey(socket, session, "C-p");
            await Bun.sleep(100);
            pane = captureVisiblePane(socket, session);
            expect(pane).toContain("Build");
            expect(pane).not.toContain("Commands");

            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "✓ copied");
            sendKey(socket, session, "Escape");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && !visible.includes("Pre-image stash"),
                "diagnostics overlay to close without transcript output",
            );
            expect(pane).not.toContain("Diagnostics");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "doctor opens the read-only process report inside the TUI",
    async () => {
        const socket = `vera-doctor-${process.pid}-${randomUUID()}`;
        const session = "doctor";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-doctor-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-child.ts",
                100,
                36,
                { VERA_TEST_STALE_DOCTOR: "1" },
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/doctor");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "checking process health…",
            );
            sendKey(socket, session, "Escape");
            await waitForVisiblePane(socket, session, "Message Vera");
            sendText(socket, session, "/doctor");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Result: issues found",
            );
            expect(pane).toContain("Doctor");
            expect(pane).toContain("Process summary");
            expect(pane).toContain("Resident hosts: 1 (1 unrecognized");
            expect(pane).toContain("PID 4242");
            expect(pane).toContain("No processes were stopped.");
            await Bun.sleep(400);
            pane = captureVisiblePane(socket, session);
            expect(pane).toContain("PID 4242");
            expect(pane).not.toContain("PID 1111");

            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "✓ copied");
            sendKey(socket, session, "Escape");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && !visible.includes("Result: issues found"),
                "doctor overlay to close without transcript output",
            );
            expect(pane).not.toContain("Process summary");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "reload failure reaches the TUI diagnostics overlay",
    async () => {
        const socket = `vera-reload-failure-${process.pid}-${randomUUID()}`;
        const session = "reload-failure";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-reload-failure-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-reload-failure-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/reload-extensions");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Client extensions reloaded with failures: none",
            );

            sendText(socket, session, "/diagnostics");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "reload       failed");
            expect(pane).toContain("reload error");
            expect(pane).not.toContain("reload       partial");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "partial reload names the extensions that stayed active",
    async () => {
        const socket = `vera-partial-reload-${process.pid}-${randomUUID()}`;
        const session = "partial-reload";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-partial-reload-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-partial-reload-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/reload-extensions");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Client extensions reloaded with failures: some",
            );

            sendText(socket, session, "/diagnostics");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "reload       partial (1 loaded)");
            expect(pane).toContain("active       test.sidebar");
            expect(pane).toContain("reload error");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "help is browse-only and ctrl+p opens the functional palette",
    async () => {
        const socket = `vera-help-${process.pid}-${randomUUID()}`;
        const session = "help";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-help-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-child.ts",
                100,
                40,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/help");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Vera keeps agent sessions resident",
            );
            expect(pane).toContain("General");
            sendKey(socket, session, "Right");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Open the command palette",
            );
            sendKey(socket, session, "Right");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Learn Vera controls and command",
            );
            sendKey(socket, session, "Enter");
            pane = captureVisiblePane(socket, session);
            expect(pane).toContain("Help");
            expect(pane).toContain("/palette");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("←→ tabs"),
                "Help to close",
            );
            // ctrl+p is the advertised way in; the /palette alias is a fallback.
            sendText(socket, session, "/");
            await waitForVisiblePane(socket, session, "Rewind the active conversation");
            sendKey(socket, session, "C-p");
            pane = await waitForVisiblePane(socket, session, "Commands");
            // The composer stays behind the overlay, and its frame carries the
            // row that says what the session is answering as.
            expect(pane).toContain("test · HIGH");
            expect(pane).toContain("settings    Switch model");
            expect(pane).not.toContain("Rewind the active conversation");
            sendText(socket, session, "switch model");
            pane = await waitForVisiblePane(socket, session, "switch model");
            expect(pane).toContain("Switch model");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Select model");
            // The composer stays behind the overlay, and its frame carries the
            // row that says what the session is answering as.
            expect(pane).toContain("test · HIGH");
            expect(pane).not.toContain("switch model");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && !visible.includes("Select model"),
                "model picker to close",
            );
            sendText(socket, session, "/palette");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Commands");
            // "recolor" is in no command name, so only description search finds
            // it: the reason the palette earns a place beside the composer.
            sendText(socket, session, "recolor");
            // Waiting for "recolor" alone matches the unfiltered list, whose
            // description column already carries the word. The filtered list is
            // the one without the rows the query dropped.
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("recolor")
                    && !visible.includes("Rename conversation"),
                "the filtered palette",
            );
            expect(pane).toContain("Change theme");
            expect(pane).toContain("/themes");
            expect(pane).not.toContain("Rename conversation");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Theme");
            expect(pane).toContain("System");
            expect(pane).not.toContain("/help");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "a refused settings change is reported in the transcript",
    async () => {
        const socket = `vera-settings-reject-${process.pid}-${randomUUID()}`;
        const session = "settings-reject";
        const home = mkdtempSync(join(tmpdir(), "vera-settings-reject-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-settings-rejection-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/model openrouter/other");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Changing the model to openrouter/other is unavailable",
            );
            // The status line kept reporting the model that is still in force.
            expect(pane).toContain("current-model · DEFAULT");

            sendText(socket, session, "/permissions auto");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Could not change permissions to auto",
            );
            expect(pane).toContain("review");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "an extension opens a sidebar beside the transcript and closes it again",
    async () => {
        const socket = `vera-sidebar-${process.pid}-${randomUUID()}`;
        const session = "sidebar";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-sidebar-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-sidebar-child.ts",
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "an open command palette gains late extension commands",
    async () => {
        const socket = `vera-help-late-${process.pid}-${randomUUID()}`;
        const session = "help-late";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-help-late-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-extension-command-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendKey(socket, session, "C-p");
            await waitForVisiblePane(socket, session, "Commands");
            sendText(socket, session, "hello");
            await waitForVisiblePane(socket, session, "hello");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Say hello from an extension",
            );
            // Searching flattens the list into one ranked run, so the group
            // column goes away and its width returns to the descriptions.
            expect(pane).not.toContain("extensions ");
            expect(pane).toContain("hello");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "the bundled quickslot uses only public client extension seams",
    async () => {
        const socket = `vera-user-quickslot-${process.pid}-${randomUUID()}`;
        const session = "user-quickslot";
        const home = mkdtempSync(join(tmpdir(), "vera-user-quickslot-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-user-quickslot-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/quickslot");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Quickslots");
            expect(pane).toContain("Slot 1");
            expect(pane).toContain("empty");

            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "kimi-k3 · low");
            expect(pane).toContain("Slot 1");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && !visible.includes("Quickslots"),
                "Quickslots to close",
            );

            sendText(socket, session, "/model openrouter/other");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Changed the model to openrouter/other; new conversations will use it by default",
            );
            expect(pane).toContain("other · LOW");
            sendText(socket, session, "/quickslot");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "kimi-k3 · low");
            sendKey(socket, session, "Enter");
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const saved = JSON.parse(readFileSync(
                    join(home, "user-quickslot-settings.json"),
                    "utf8",
                ));
                if (saved.model === "moonshotai/kimi-k3") break;
                await Bun.sleep(20);
            }
            expect(JSON.parse(readFileSync(
                join(home, "user-quickslot-settings.json"),
                "utf8",
            ))).toMatchObject({
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                reasoningEffort: "low",
            });
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "turn completion keeps focus in the open Help surface",
    async () => {
        const socket = `vera-help-focus-${process.pid}-${randomUUID()}`;
        const session = "help-focus";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-help-focus-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-help-active-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "start");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "STREAM");
            sendText(socket, session, "/help");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "Vera keeps agent sessions resident",
            );
            // Two rows since the status split across footer lines: the model
            // shortcut above, then the persistent ready and command controls.
            pane = await waitForVisiblePane(
                socket,
                session,
                "ctrl+shift+m model",
            );
            expect(pane).toContain("ready · ctrl+p commands");
            const footerLines = pane.split("\n");
            const modelHintLine = footerLines.findIndex((line) =>
                line.includes("ctrl+shift+m model")
            );
            const readyLine = footerLines.findIndex((line) =>
                line.includes("ready · ctrl+p commands")
            );
            expect(modelHintLine).toBe(readyLine - 1);
            expect(Bun.stringWidth(footerLines[modelHintLine]!))
                .toBeLessThanOrEqual(100);
            // One key at a time, each waiting for the card it opened. Sending
            // both and typing straight after raced the redraw, and a key that
            // lands mid-redraw is a key the surface never sees.
            sendKey(socket, session, "Right");
            await waitForVisiblePane(socket, session, "Search");
            sendKey(socket, session, "Right");
            await waitForVisiblePane(socket, session, "/rename");
            sendText(socket, session, "themes");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) =>
                    visible.includes("/themes") && !visible.includes("/rename"),
                "the command list narrowed to the search",
            );
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "resident stream failure becomes a recoverable disconnected TUI",
    async () => {
        const socket = `vera-connection-error-${process.pid}-${randomUUID()}`;
        const session = "connection-error";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-connection-error-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-connection-error-child.ts",
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "disconnected: Host sent a non-contiguous agent",
            );
            expect(pane).not.toContain("Connection error");
            expect(pane).toContain("· /reconnect host · ctrl+c quit");
            expect(pane).not.toContain("working…");
            expect(pane).not.toContain("stopping");

            sendText(socket, session, "/reconnect");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Host reconnected.");
            expect(pane).toContain("ready · ctrl+p commands");
            expect(pane).not.toContain("/reconnect host");

            sendText(socket, session, "/themes");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Theme");
            expect(pane).toContain("System");

            sendKey(socket, session, "Escape");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "resident agent death renders as a separated fatal diagnostic",
    async () => {
        const socket = `vera-fatal-diagnostic-${process.pid}-${randomUUID()}`;
        const session = "fatal-diagnostic";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-fatal-diagnostic-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-fatal-diagnostic-child.ts",
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "Resident agent stopped unexpectedly",
            );
            expect(pane).toMatch(
                /^ {2}× stopped  Resident agent stopped unexpectedly$/m,
            );
            expect(pane).toMatch(
                /^ {2}× Reviewer denied bash \(high risk\): The permission gate denied this operation\.$/m,
            );
            expect(pane).toMatch(
                /Reviewer denied bash[^\n]*\n[^\S\n]*\n {2}× stopped/,
            );
            expect(pane).not.toContain("# Agent error");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "terminal model errors remain visible after tools and the next turn works",
    async () => {
        const socket = `vera-terminal-error-${process.pid}-${randomUUID()}`;
        const session = "terminal-error";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-terminal-error-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-terminal-error-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "inspect then answer");
            sendKey(socket, session, "Enter");

            pane = await waitForVisiblePane(
                socket,
                session,
                "Model error: Model returned no visible response or structured tool call.",
            );
            expect(pane).toMatch(
                /Explored {2}Read package\.json\s+ctrl\+e details/,
            );

            sendText(socket, session, "try again");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "RECOVERED AFTER ERROR",
            );
            expect(pane).toContain("try again");

            sendKey(socket, session, "Up");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => occurrences(visible, "try again") >= 2,
                "the last submitted message in the composer",
            );
            expect(occurrences(pane, "try again")).toBeGreaterThanOrEqual(2);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "clear command leaves the current conversation for a fresh one",
    async () => {
        const socket = `vera-new-${process.pid}-${randomUUID()}`;
        const session = "new";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-new-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-new-session-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            pane = await waitForVisiblePane(socket, session, "current-model");
            expect(pane).not.toContain("FULL ACCESS");
            sendText(socket, session, "/clear");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Could not start a new session: host refused creation",
            );
            expect(pane).toContain("ready");
            sendText(socket, session, "/clear");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "starting new session",
            );
            pane = captureVisiblePane(socket, session);
            expect(pane).toContain("Start a conversation");
            expect(pane).not.toContain("host refused creation");
            // The new session lands in the same TUI: the activity clears and
            // the failure notice goes with the transcript that held it, while
            // the process the pane belongs to is still the one that started.
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) =>
                    !visible.includes("starting new session")
                    && !visible.includes("host refused creation"),
                "the new session on screen",
            );
            expect(pane).toContain("Start a conversation");
            // The fresh session reports its own model and its own approval
            // mode: the status line never keeps describing the one that left.
            pane = await waitForVisiblePane(socket, session, "fresh-model");
            expect(pane).toContain("FULL ACCESS · RED ZONE");
            expect(pane).not.toContain("current-model");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(
                join(home, "new-session-result.txt"),
                "utf8",
            )).toBe(
                "new-session-id\ndetached\nnext detached\nattempts 2\n/work/vera",
            );
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "rename commands name and clear without reaching the model",
    async () => {
        const socket = `vera-rename-${process.pid}-${randomUUID()}`;
        const session = "rename";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-rename-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/rename Planning");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "session renamed: Planning",
            );
            expect(pane).not.toContain("/rename Planning");

            sendText(socket, session, "/rename");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "session name cleared");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(join(home, "rename-result.txt"), "utf8"))
                .toBe("Planning\n<clear>");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "extension slash commands stay in the TUI and render attributed results",
    async () => {
        const socket = `vera-extension-${process.pid}-${randomUUID()}`;
        const session = "extension";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-extension-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-extension-command-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/hello too early");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Extension commands are still loading",
            );
            expect(existsSync(
                join(home, "extension-command-result.txt"),
            )).toBeFalse();
            sendKey(socket, session, "C-u");
            sendText(socket, session, "/hell");
            pane = await waitForVisiblePane(
                socket,
                session,
                "/hello  Say hello from an extension",
            );
            expect(pane).toContain("/hello");
            sendKey(socket, session, "Tab");
            sendText(socket, session, " fail");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "running /hello · ctrl+c quit",
            );
            expect(pane).toContain("running /hello");
            pane = await waitForVisiblePane(
                socket,
                session,
                "test.extension/hello: extension failed for test",
            );
            expect(pane).toContain("ready");
            expect(pane).toContain("/hello fail");
            sendKey(socket, session, "C-u");
            sendText(socket, session, "/hello");
            sendText(socket, session, " Nash");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "test.extension/hello [info]: Hello Nash",
            );
            expect(pane).toContain("ready");
            expect(readFileSync(
                join(home, "extension-command-result.txt"),
                "utf8",
            )).toBe("hello\nNash");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "clone switches to the replacement without restarting the TUI",
    async () => {
        const socket = `vera-clone-${process.pid}-${randomUUID()}`;
        const session = "clone";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-clone-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-clone-session-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/clone");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "cloning session");
            // A second /clone while the first is still in flight is dropped,
            // which the attempt count below is what proves.
            sendText(socket, session, "/clone");
            sendKey(socket, session, "Enter");
            expect(captureVisiblePane(socket, session))
                .toContain("cloning session");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("cloning session"),
                "the clone on screen",
            );
            expect(pane).toContain("Start a conversation");
            // The clone reports its own model and approval mode rather than
            // inheriting the status line the source session left behind.
            pane = await waitForVisiblePane(socket, session, "cloned-model");
            expect(pane).toContain("FULL ACCESS · RED ZONE");
            expect(pane).not.toContain("source-model");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(
                join(home, "clone-session-result.txt"),
                "utf8",
            )).toBe("cloned-session\ndetached\nattempts 1\nsource-session");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "fork prepares a replacement and restores the selected prompt",
    async () => {
        const socket = `vera-fork-${process.pid}-${randomUUID()}`;
        const session = "fork";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-fork-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-fork-session-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/fork");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Fork session");
            expect(pane).toContain("edit this prompt");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "forking session");
            // The fork lands in the same TUI: the prompt it was taken before
            // comes back to the composer without the screen being rebuilt.
            pane = await waitForVisiblePane(socket, session, "1 image attached");
            expect(pane).toContain("edit this prompt");
            expect(pane).not.toContain("forking session");
            // The fork reports its own model and approval mode.
            pane = await waitForVisiblePane(socket, session, "forked-model");
            expect(pane).toContain("FULL ACCESS · RED ZONE");
            expect(pane).not.toContain("source-model");
            // The first interrupt clears the restored draft and attachment;
            // the second exits the now-idle TUI.
            sendKey(socket, session, "C-c");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(JSON.parse(readFileSync(
                join(home, "fork-session-result.txt"),
                "utf8",
            ))).toEqual({
                agentId: "forked-session",
                detached: true,
                forkBoundary: "prompt-1",
                forkedFrom: "source-session",
            });
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "a stalled fork returns control to the source session",
    async () => {
        const socket = `vera-fork-timeout-${process.pid}-${randomUUID()}`;
        const session = "fork-timeout";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-fork-timeout-"));
        let pane = "";

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    "FORK_TIMEOUT=1"
                } ${shellQuote(process.execPath)} run ${
                    shellQuote("test/support/tui-fork-session-child.ts")
                }`,
            ]);
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/fork");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Fork session");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Could not fork this session: timed out",
            );
            expect(pane).toContain("ready");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

/**
 * Every session switch races the same deadline. A host that never answers used
 * to leave the TUI in a pending switch with no notice, no new prompt, and no
 * way to quit, so each of these drives the switch a different way and asserts
 * the same recovery: a notice, the old session still on screen, and ready.
 */
const stalledSwitches = [
    {
        name: "clear",
        child: "test/support/tui-new-session-child.ts",
        env: { CREATE_TIMEOUT: "1" },
        open: (socket: string, session: string): void => {
            sendText(socket, session, "/clear");
            sendKey(socket, session, "Enter");
        },
        notice: "Could not start a new session: timed out",
        survivor: "current-model",
    },
    {
        name: "clone",
        child: "test/support/tui-clone-session-child.ts",
        env: { CLONE_TIMEOUT: "1" },
        open: (socket: string, session: string): void => {
            sendText(socket, session, "/clone");
            sendKey(socket, session, "Enter");
        },
        notice: "Could not clone this session: timed out",
        survivor: "source-model",
    },
] as const;

for (const stalled of stalledSwitches) {
    test.skipIf(!tmuxAvailable)(
        `a stalled ${stalled.name} returns control to the current session`,
        async () => {
            const socket = `vera-${stalled.name}-timeout-${process.pid}-${
                randomUUID()
            }`;
            const session = `${stalled.name}-timeout`;
            const home = mkdtempSync(
                join(tmpdir(), `vera-tui-${stalled.name}-timeout-`),
            );
            let pane = "";

            try {
                startTuiSession(
                    socket,
                    session,
                    home,
                    stalled.child,
                    100,
                    30,
                    stalled.env,
                );
                await waitForVisiblePane(socket, session, "Start a conversation");
                stalled.open(socket, session);
                pane = await waitForVisiblePane(socket, session, stalled.notice);
                expect(pane).toContain("ready");
                // The session that was on screen is still the attached one.
                expect(pane).toContain(stalled.survivor);
                sendKey(socket, session, "C-c");
                await waitForSessionExit(socket, session);
            } catch (error) {
                pane = captureVisiblePane(socket, session);
                throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
            } finally {
                Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
                rmSync(home, { recursive: true, force: true });
            }
        },
        15_000,
    );
}

test.skipIf(!tmuxAvailable)(
    "a stalled resume returns control to the current session",
    async () => {
        const socket = `vera-resume-timeout-${process.pid}-${randomUUID()}`;
        const session = "resume-timeout";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-timeout-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-resume-child.ts",
                100,
                30,
                { RESUME_TIMEOUT: "1" },
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Continue the theme picker");
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Could not switch conversation: timed out",
            );
            expect(pane).toContain("ready");
            expect(pane).toContain("current-model");
            expect(pane).not.toContain("RESUMED HISTORY LOADED");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "ctrl+c quits while a session switch is still pending",
    async () => {
        const socket = `vera-switch-quit-${process.pid}-${randomUUID()}`;
        const session = "switch-quit";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-switch-quit-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-fork-session-child.ts",
                100,
                30,
                { FORK_TIMEOUT: "hold" },
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/fork");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Fork session");
            sendKey(socket, session, "Enter");
            // The deadline is a minute out, so the switch is still pending and
            // ctrl+c is the only way out of it.
            pane = await waitForVisiblePane(socket, session, "forking session");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "resume picker switches conversation without restarting the TUI",
    async () => {
        const socket = `vera-resume-${process.pid}-${randomUUID()}`;
        const session = "resume";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-resume-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Continue the theme picker",
            );
            // The session already on screen is listed and says so, and Enter on
            // its row is a way out of the picker rather than a re-attach.
            expect(pane).toContain("The one already open");
            expect(pane).toContain("● just now");
            expect(pane).toContain("1h ago");
            expect(pane).not.toContain("empty-session-id");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => !visible.includes("Continue the theme picker"),
                "the picker to close on the current session",
            );
            expect(pane).not.toContain("RESUMED HISTORY LOADED");

            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Continue the theme picker");
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "RESUMED HISTORY LOADED",
            );
            expect(pane).not.toContain("Continue the theme picker");
            // The pane belongs to the process that started: the transcript was
            // replaced under a TUI that never went away.
            expect(pane).toContain("Message Vera");
            // The resumed session's own model and approval mode, not the ones
            // belonging to the conversation that was on screen.
            pane = await waitForVisiblePane(socket, session, "resumed-model");
            expect(pane).toContain("FULL ACCESS · RED ZONE");
            expect(pane).not.toContain("current-model");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
                .toBe(
                    "/sessions/target.jsonl\ndetached\ntarget-session-id",
                );
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-tui-trash-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "session picker renames a conversation it is not attached to",
    async () => {
        const socket = `vera-rename-${process.pid}-${randomUUID()}`;
        const session = "rename";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-rename-session-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Continue the theme picker",
            );
            expect(pane).toContain("^r rename");
            sendKey(socket, session, "C-r");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Rename conversation",
            );
            // The field opens empty: the row text is a fallback, not a name.
            expect(pane).not.toContain("Rename conversation\nContinue");
            sendText(socket, session, "release notes");
            sendKey(socket, session, "Enter");
            // The pane comes back rebuilt from the host rather than patched.
            await waitForVisiblePane(socket, session, "release notes");
            sendKey(socket, session, "Escape");
            // The notice lands in the transcript, which the pane was covering.
            pane = await waitForVisiblePane(
                socket,
                session,
                "session renamed: release notes",
            );
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(
                join(home, "rename-session-result.txt"),
                "utf8",
            )).toBe(
                "saved-session release notes\ncurrent Fix the deployment race",
            );
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "renaming the attached row goes through its own session",
    async () => {
        const socket = `vera-rename-current-${process.pid}-${randomUUID()}`;
        const session = "rename-current";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-current-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-rename-session-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Fix the deployment race");
            sendKey(socket, session, "Down");
            sendKey(socket, session, "C-r");
            await waitForVisiblePane(socket, session, "Rename conversation");
            sendText(socket, session, "the current one");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "the current one");
            sendKey(socket, session, "Escape");
            pane = await waitForVisiblePane(
                socket,
                session,
                "session renamed: the current one",
            );
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            // The host was never asked: the attached session renames itself,
            // and the host refuses an attached target anyway.
            expect(readFileSync(
                join(home, "rename-session-result.txt"),
                "utf8",
            )).toBe("\ncurrent the current one");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "a refused rename says so and leaves the pane open",
    async () => {
        const socket = `vera-rename-busy-${process.pid}-${randomUUID()}`;
        const session = "rename-busy";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-busy-"));
        let pane = "";

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    "RENAME_BUSY=1"
                } ${shellQuote(process.execPath)} run ${
                    shellQuote("test/support/tui-rename-session-child.ts")
                }`,
            ]);
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "Continue the theme picker",
            );
            sendKey(socket, session, "C-r");
            await waitForVisiblePane(socket, session, "Rename conversation");
            sendText(socket, session, "release notes");
            sendKey(socket, session, "Enter");
            // The pane comes back with the row still under its old name.
            pane = await waitForVisiblePane(socket, session, "^r rename");
            expect(pane).toContain("Continue the theme picker");
            sendKey(socket, session, "Escape");
            pane = await waitForVisiblePane(
                socket,
                session,
                "open in another client",
            );
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "session trash rejection keeps the picker usable",
    async () => {
        const socket = `vera-trash-busy-${process.pid}-${randomUUID()}`;
        const session = "trash-busy";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-trash-busy-"));
        let pane = "";

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    "TRASH_BUSY=1"
                } ${shellQuote(process.execPath)} run ${
                    shellQuote("test/support/tui-trash-session-child.ts")
                }`,
            ]);
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/resume");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "Continue the theme picker",
            );
            sendKey(socket, session, "DC");
            await waitForVisiblePane(
                socket,
                session,
                "Move conversation to Trash?",
            );
            sendText(socket, session, "1");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => current.includes("Continue the theme picker")
                    && !current.includes("Move conversation to Trash?"),
                "restored session picker after trash rejection",
            );
            expect(pane).toContain("Continue the theme picker");
            sendKey(socket, session, "Escape");
            pane = await waitForVisiblePane(socket, session, "That con");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "settings picker restores the composer and the next Enter submits",
    async () => {
        const socket = `vera-settings-${process.pid}-${randomUUID()}`;
        const session = "settings";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-settings-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-settings-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/themes");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Theme");
            expect(pane).toContain("Night Owl");
            sendText(socket, session, "owl");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "theme changed: nightowl",
            );
            expect(JSON.parse(readFileSync(join(profileDirectory(home), "tui.json"), "utf8")))
                .toEqual({
                    theme: "nightowl",
                    animation: "conveyor",
                });

            sendText(socket, session, "/effort");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Reasoning");
            expect(pane).toContain("High");

            // The selected row is now a background highlight rather than a "›"
            // caret, so it does not show up in tmux's text-only capture. The
            // The MAX wait below is the real guard: the status line
            // only reads that way if Down moved the selection off High.
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "test · MAX",
            );

            sendText(socket, session, "testing");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "SETTINGS TURN WORKED",
            );
            expect(pane).toContain("testing");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "real TUI queues a prompt and Escape steers to it",
    async () => {
        const socket = `vera-test-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
        let pane = "";

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    shellQuote(process.execPath)
                } run test/support/tui-child.ts`,
            ]);

            pane = await waitForPane(socket, session, "test · HIGH");
            expect(pane).toContain("Start a conversation");
            expect(pane).toContain("ready · ctrl+p commands");
            expect(pane).not.toContain("shift+enter newline");
            sendText(socket, session, "start streaming");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "esc stop");
            expect(pane).toMatch(/[░▒▓█]{7} (thinking|responding) · \d+s/);
            expect(pane).toContain("esc stop");
            expect(pane).not.toContain("enter queue");
            const workingLines = pane.split("\n");
            const activityLine = workingLines.find((line) =>
                line.includes("esc stop")
            );
            const placeLine = workingLines.find((line) =>
                line.includes("ready · ctrl+p commands")
            );
            expect(activityLine).toBeDefined();
            expect(placeLine).toBeDefined();
            if (activityLine === undefined || placeLine === undefined) {
                throw new Error("missing fixed activity or place row");
            }
            const activityLabel = Math.max(
                activityLine.indexOf("thinking"),
                activityLine.indexOf("responding"),
            );
            expect(activityLabel).toBeGreaterThanOrEqual(0);
            expect(activityLine.indexOf("esc stop")).toBeGreaterThan(
                activityLabel,
            );
            expect(activityLine).toEndWith("esc stop · ctrl+c stop");
            expect(activityLine.length).toBe(96);
            expect(workingLines.indexOf(activityLine)).toBeLessThan(
                workingLines.indexOf(placeLine),
            );

            pane = await waitForPane(socket, session, "PARTIAL xxxxx");
            expect(pane).toMatch(/[░▒▓█]{7} responding · \d+s/);
            expect(pane).toContain("esc stop");
            // No fold marker: this turn reasons without producing any summary
            // text, so there is nothing behind the line to open.
            expect(pane).toMatch(/(?<![▸▾] )(?:Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+\.\d+s/);
            sendText(socket, session, "redirect now");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "queued · redirect now");
            expect(pane.split("\n").find((line) =>
                line.includes("queued · redirect now")
            )).toMatch(/^  queued · redirect now/);
            sendKey(socket, session, "Escape");

            pane = await waitForPane(socket, session, "STEER WORKED");
            expect(pane).toContain("PARTIAL xxxxx");
            expect(pane).toContain("redirect now");
            expect(pane).not.toContain("FIRST-END");
            // The estimate stands while the request is in flight, so the
            // provider's own count only replaces it once the turn ends.
            pane = await waitForPane(socket, session, "ctx ~");
            expect(pane).toContain("100%");

            // The second turn reasons, so its summary carries a fold that
            // ctrl+o opens over a row already drawn.
            expect(pane).toMatch(/▸ Reasoning: \d+\.\d+s/);
            expect(pane).not.toContain("WEIGHING THE ORDERINGS");
            sendKey(socket, session, "C-u");
            pane = await waitForPane(socket, session, "PARTIAL xxxxx");
            sendKey(socket, session, "C-o");
            pane = await waitForPane(socket, session, "WEIGHING THE ORDERINGS");
            expect(pane).toMatch(/▾ Reasoning: \d+\.\d+s/);
            expect(pane).toContain("ctrl+o hide reasoning");
            expect(pane).toContain("PARTIAL xxxxx");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "rewind picker preserves global Ctrl-C and restores focus after failure",
    async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-rewind-edges-"));
        const failureSocket = `vera-rewind-failure-${process.pid}-${randomUUID()}`;
        const interruptSocket = `vera-rewind-interrupt-${process.pid}-${randomUUID()}`;

        try {
            startTuiSession(
                failureSocket,
                "failure",
                home,
                "test/support/tui-rewind-failure-child.ts",
            );
            await waitForPane(failureSocket, "failure", "Start a conversation");
            sendText(failureSocket, "failure", "/rewind");
            sendKey(failureSocket, "failure", "Enter");
            await waitForPane(failureSocket, "failure", "timeline unavailable");
            sendText(failureSocket, "failure", "composer works");
            expect(await waitForPane(failureSocket, "failure", "composer works"))
                .toContain("composer works");

            startTuiSession(
                interruptSocket,
                "interrupt",
                home,
                "test/support/tui-rewind-child.ts",
            );
            await waitForPane(interruptSocket, "interrupt", "Start a conversation");
            sendText(interruptSocket, "interrupt", "/rewind");
            sendKey(interruptSocket, "interrupt", "Enter");
            await waitForPane(interruptSocket, "interrupt", "Rewind: select a point");
            sendKey(interruptSocket, "interrupt", "C-c");
            await waitForSessionExit(interruptSocket, "interrupt");
        } finally {
            for (const socket of [failureSocket, interruptSocket]) {
                Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
            }
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "long tool output folds and Ctrl-E reveals it",
    async () => {
        const socket = `vera-tool-details-${process.pid}-${randomUUID()}`;
        const session = "tool-details";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-tool-details-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-tool-details-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "show the details");
            sendKey(socket, session, "Enter");

            pane = await waitForVisiblePane(
                socket,
                session,
                "TOOL DETAILS COMPLETED",
            );
            expect(pane).toMatch(/· ask +│$/m);
            expect(pane).toContain("Ran  printf");
            expect(pane).not.toContain("TOOL_DETAIL_09");
            expect(pane).toMatch(/^• Baked for 0\.0s\n {2}Ran/m);
            expect(pane).toMatch(/^ {2}─{20}/m);
            expect(pane).toMatch(/^• TOOL DETAILS COMPLETED$/m);
            expect(pane).toMatch(/^ {3}Tip /m);
            expect(pane).toMatch(/^ {2}╭─{20}/m);

            sendKey(socket, session, "C-e");
            pane = await waitForVisiblePane(socket, session, "TOOL_DETAIL_09");
            expect(pane).toMatch(/▾ Ran\s+ctrl\+e details/);
            expect(pane).toContain("TOOL DETAILS COMPLETED");

            sendKey(socket, session, "C-e");
            pane = await waitForVisiblePane(socket, session, "Ran  printf");

            sendText(socket, session, "run one short action");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SHORT TOOL COMPLETED");
            expect(pane).toMatch(/Ran {2}printf 'SHORT_DETAIL/);
            expect(pane.match(/SHORT_DETAIL/g)).toHaveLength(2);

            sendKey(socket, session, "C-e");
            pane = await waitForVisiblePane(socket, session, "└ SHORT_DETAIL");
            // Expanded details deliberately show both what ran and its short
            // result; this command prints the same sentinel in each.
            expect(pane.match(/SHORT_DETAIL/g)).toHaveLength(2);
            expect(pane).toContain("SHORT TOOL COMPLETED");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "persisted TUI appearance config controls transcript and composer layout",
    async () => {
        const socket = `vera-appearance-${process.pid}-${randomUUID()}`;
        const session = "appearance";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-appearance-"));
        const configDirectory = profileDirectory(home);
        let pane = "";

        mkdirSync(configDirectory, { recursive: true });
        writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            tui: {
                transcript: {
                    padding_left: 2,
                    padding_right: 3,
                    activity_indent: 3,
                    message_spacing: 1,
                    tool_group_spacing: 1,
                    separator_visible: false,
                    separator_spacing_before: 1,
                    separator_spacing_after: 1,
                    separator_color: "#112233",
                },
                composer: {
                    margin_horizontal: 4,
                    padding_horizontal: 2,
                    tip_indent: 5,
                    boundary_color: "#334455",
                },
            },
        }));

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-tool-details-child.ts",
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "Start a conversation",
            );
            expect(pane).toMatch(/^ {5}Start a conversation with Vera\.$/m);
            sendText(socket, session, "show configured layout");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "TOOL DETAILS COMPLETED",
            );
            expect(pane).toMatch(/· ask +│$/m);

            expect(pane).toMatch(/^ {5}Ran/m);
            expect(pane).not.toMatch(/^ {5}─{20}/m);
            expect(pane).toMatch(/^ {2}• {2}TOOL DETAILS COMPLETED$/m);
            expect(pane).toMatch(/^ {5}Tip /m);
            expect(pane).toMatch(/^ {4}╭─{20}/m);

            const lines = pane.split("\n");
            const answer = lines.findIndex((line) =>
                line.includes("TOOL DETAILS COMPLETED")
            );
            expect(answer).toBeGreaterThan(2);
            expect(lines[answer - 1]?.trim()).toBe("");
            expect(lines[answer - 2]?.trim()).toBe("");

            const styled = captureVisiblePaneWithStyles(socket, session);
            // tmux's default 256-color terminal maps the requested RGB values
            // to their nearest palette entries in the captured pane.
            expect(styled).toMatch(/\x1b\[38;5;238m╭/);

            runTmux(socket, [
                "resize-window",
                "-t",
                session,
                "-x",
                "20",
                "-y",
                "34",
            ]);
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => /^ {3}╭─{10}/m.test(current),
                "composer fitted to a narrow terminal",
            );
            expect(pane).toMatch(/^ {3}╭─{10}/m);
            expect(pane).toMatch(/^ {3}│Message/m);
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "auto reviews a boundary crossing without asking the user",
    async () => {
        const socket = `vera-auto-review-${process.pid}-${randomUUID()}`;
        const session = "auto-review";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-auto-review-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-auto-review-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "run the routine command");
            sendKey(socket, session, "Enter");

            pane = await waitForVisiblePane(
                socket,
                session,
                "AUTO REVIEW COMPLETED",
            );
            expect(readFileSync(join(home, "auto-review-invoked"), "utf8"))
                .toBe("allowed\n");
            expect(pane).toContain(
                "Auto review approved bash (risk: low, authorization: high):",
            );
            expect(pane.replace(/\s+/g, " ")).toContain(
                "Routine command requested by the user.",
            );
            // `env` prints as many lines as the machine has variables, so
            // the row is pinned by its command and its details hint.
            expect(pane).toContain("Ran  env AUTO_REVIEW=ran");
            expect(pane).toContain("ctrl+e details");
            expect(pane).toContain("auto");
            expect(pane).not.toContain("Permission required");
            expect(pane).not.toContain("Allow once");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "approval actions stay visible above long details",
    async () => {
        const socket = `vera-approval-layout-${process.pid}-${randomUUID()}`;
        const session = "approval";
        const home = mkdtempSync(join(tmpdir(), "vera-approval-layout-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-approval-child.ts",
                42,
                10,
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "Allow once",
            );
            expect(pane).toContain("Permission required");
            expect(pane).toContain("$ grep");
            expect(pane).not.toContain("approval required ·");
            expect(pane).not.toContain("gpt-5.6-sol");

            // Down moves the highlight across the answers, so the details
            // scroll by page.
            for (let index = 0; index < 20; index += 1) {
                sendKey(socket, session, "NPage");
            }
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => current.includes(
                    "Session and always are unavailable.",
                ) && !current.includes("$ grep"),
                "scrolled approval actions",
            );
            expect(pane).toContain("Allow once");
            expect(pane).not.toContain("$ grep");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "child approval shows only exact allow and deny",
    async () => {
        const socket = `vera-child-approval-${process.pid}-${randomUUID()}`;
        const session = "child-approval";
        const home = mkdtempSync(join(tmpdir(), "vera-child-approval-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-child-approval-child.ts",
                80,
                18,
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "Requested by agent 5a5d7460",
            );
            expect(pane).toContain("Task: Write the child approval marker");
            expect(pane).toContain("1 Allow once");
            expect(pane).toContain("3 Deny");
            expect(pane).not.toContain("2 Session");
            expect(pane).not.toContain("4 Always");
            expect(pane).not.toContain("session prefix");
            expect(pane).not.toContain("ask.default");

            sendKey(socket, session, "1");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => !current.includes("Requested by agent"),
                "closed child approval",
            );
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "user question accepts a digit immediately and restores composer focus",
    async () => {
        const socket = `vera-question-${process.pid}-${randomUUID()}`;
        const session = "question";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-question-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-question-child.ts",
                42,
                20,
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "1. Stable",
            );
            expect(pane).toContain("Which release channel");
            expect(pane).toContain("2. Preview");
            expect(pane).toContain("3. Nightly");
            expect(pane).not.toContain("question waiting");
            expect(pane).not.toContain("gpt-5.6-sol");
            // The reproduction for the status-line collision: above the short
            // terminal threshold the overlay clears the status line's row, so
            // its final line of key hints survives instead of being drawn over.
            // The 42x10 approval test covers the other side of the threshold,
            // where the row goes back to the content.
            expect(pane).toContain("esc dismiss");

            sendText(socket, session, "2");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Selection received: preview-channel",
            );
            expect(pane).not.toContain("esc dismiss");

            sendText(socket, session, "focus restored");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "FOCUS RESTORED");
            expect(pane).toContain("focus restored");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "real TUI mouse drag copies transcript text and keeps it highlighted",
    async () => {
        const socket = `vera-selection-${process.pid}-${randomUUID()}`;
        const session = "selection";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-selection-"));
        const copiedTextPath = join(home, "copied-text");
        const selectedText = "COPY THIS TEXT";
        let pane = "";

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} VERA_TEST_COPIED_TEXT_PATH=${shellQuote(copiedTextPath)} ${
                    shellQuote(process.execPath)
                } run test/support/tui-selection-child.ts`,
            ]);

            pane = await waitForVisiblePane(socket, session, selectedText);
            const lines = pane.split("\n");
            const row = lines.findIndex((line) => line.includes(selectedText));
            const selectedLine = lines[row];
            if (selectedLine === undefined) {
                throw new Error("Selected transcript line was not visible");
            }
            const column = selectedLine.indexOf(selectedText);

            sendMouseDrag(
                socket,
                session,
                column + 1,
                row + 1,
                column + selectedText.length + 1,
                row + 1,
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                `copied ${selectedText.length} characters`,
            );
            expect(readFileSync(copiedTextPath, "utf8")).toBe(selectedText);
            // Nobody else is in this conversation, so the selection was a
            // copy and only a copy: the next message is not armed with it.
            expect(pane).not.toContain("quoting");

            const styledPane = captureVisiblePaneWithStyles(socket, session);
            expect(styledPane).toMatch(
                new RegExp(
                    `\\x1b\\[48;(?:2;\\d+;\\d+;\\d+|5;\\d+)m${selectedText}`,
                ),
            );
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
    height = 34,
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
        } VERA_HOME=${shellQuote(join(home, ".vera"))} ${exported}${shellQuote(process.execPath)} run ${
            shellQuote(childPath)
        }`,
    ]);
}

test.skipIf(!tmuxAvailable)(
    "real TUI previews and confirms conversation-only rewind",
    async () => {
        const socket = `vera-rewind-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-rewind-test-"));
        let pane = "";

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    shellQuote(process.execPath)
                } run test/support/tui-rewind-child.ts`,
            ]);

            pane = await exerciseConversationRewind(socket, session);
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "real TUI rewinds through a separate resident host process",
    async () => {
        const socket = `vera-resident-flow-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = mkdtempSync(join(tmpdir(), "vera-resident-flow-"));
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach rewind-agent`,
            ]);
            pane = await exerciseConversationRewind(socket, session);
            expect(pane).not.toContain("Connection error");
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
    "agent inbox notice emphasizes and replaces the current unread count",
    async () => {
        const socket = `vera-inbox-notice-${process.pid}-${randomUUID()}`;
        const session = "inbox-notice";
        const home = mkdtempSync(join(tmpdir(), "vera-inbox-notice-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-inbox-notice-child.ts",
            );
            pane = await waitForVisiblePane(socket, session, "Agent inbox");
            expect(pane).toContain("〰 Agent inbox 〰");
            expect(pane).toContain("2 unread inbox entries");
            expect(pane).not.toContain("1 unread inbox entry");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-roster-"));
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-local-loop-"));
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
                    shellQuote(process.execPath)
                } run clients/cli/main.ts attach left`,
            ]);
            runTmux(socket, [
                "split-window",
                "-h",
                "-t",
                leftPane,
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-resident-rewind-"));
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            await stopTemporaryHost(home);
            rmSync(home, { recursive: true, force: true });
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "scrolling away from the stream offers a way back to the bottom",
    async () => {
        const socket = `vera-jump-bottom-${process.pid}-${randomUUID()}`;
        const session = "jump-bottom";
        const home = mkdtempSync(join(tmpdir(), "vera-jump-bottom-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-child.ts",
                100,
                18,
            );
            await waitForPane(socket, session, "Start a conversation");
            expect(pane).not.toContain("Jump to bottom");

            sendText(socket, session, "start streaming");
            sendKey(socket, session, "Enter");
            pane = await waitForPane(socket, session, "PARTIAL xxxxx");

            for (let index = 0; index < 6; index += 1) {
                sendEscapeSequence(socket, session, "\x1b[1;5A");
            }
            pane = await waitForPane(socket, session, "Jump to bottom");

            sendEscapeSequence(socket, session, "\x1b[1;5F");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => !current.includes("Jump to bottom"),
                "pill hidden after the keyboard jump",
            );

            // The wheel is the other way back, and it has to re-engage the
            // same follow the keys do.
            sendMouseWheel(socket, session, "up", 20, 4, 10);
            pane = await waitForPane(socket, session, "Jump to bottom");
            sendMouseWheel(socket, session, "down", 20, 4, 40);
            await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => !current.includes("Jump to bottom"),
                "pill hidden at the bottom",
            );
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);

test.skipIf(!tmuxAvailable)(
    "btw and pair expose working focus, layout, and green rail controls",
    async () => {
        const socket = `vera-btw-controls-${process.pid}-${randomUUID()}`;
        const session = "btw-controls";
        const home = mkdtempSync(join(tmpdir(), "vera-btw-controls-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    20_000,
);

test.skipIf(!tmuxAvailable)(
    "quickslot changes the focused BTW and Pair agent without changing Vera",
    async () => {
        const socket = `vera-focused-quickslot-${process.pid}-${randomUUID()}`;
        const session = "focused-quickslot";
        const home = mkdtempSync(join(tmpdir(), "vera-focused-quickslot-"));
        let pane = "";

        try {
            mkdirSync(profileDirectory(home), { recursive: true });
            writeFileSync(join(profileDirectory(home), "tui.json"), JSON.stringify({
                extensions: {
                    "vera.model-presets": {
                        slots: [
                            {
                                provider: "faux",
                                model: "test",
                                reasoningEffort: "low",
                            },
                            {
                                provider: "faux",
                                model: "test",
                                reasoningEffort: "high",
                            },
                            null,
                            null,
                        ],
                        "current-slot": 1,
                    },
                },
            }));
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
            await waitForVisiblePane(socket, session, "Message sidekick");
            sendEscapeSequence(socket, session, "\x1b[Z");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message sidekick")
                    && visible.includes("test · LOW"),
                "Quickslot to change the focused sidekick",
            );
            expect(pane).toContain("quickslot 1: test · low");

            sendKey(socket, session, "C-g");
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && visible.includes("test · HIGH"),
                "Vera to retain its model settings",
            );

            sendText(socket, session, "/pair");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Message peer");
            sendEscapeSequence(socket, session, "\x1b[Z");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message peer")
                    && visible.includes("test · LOW"),
                "Quickslot to change the focused peer",
            );

            sendKey(socket, session, "C-g");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera")
                    && visible.includes("test · HIGH"),
                "Vera to remain unchanged after changing the peer",
            );
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-btw-hosted-"));
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

            sendText(socket, session, "/");
            await waitForVisiblePane(
                socket,
                session,
                "Rewind the active conversation",
            );
            sendKey(socket, session, "C-u");

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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-btw-image-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-pair-hosted-"));
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

            sendText(socket, session, "/permissions readonly");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "peer · readonly");

            sendText(socket, session, "/clear");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Message peer");
            sendText(socket, session, "fresh peer");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "PEER ANSWERED 1");
            expect(pane).not.toContain("inspect this");

            sendKey(socket, session, "C-g");
            sendText(socket, session, "main only");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED 1");
            expect(pane).not.toContain("PEER ANSWERED 2");
        } catch (error) {
            pane = captureVisiblePane(socket, session);
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-advisor-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-btw-context-"));
        const readyPath = join(home, "host-ready");
        let pane = "";
        mkdirSync(profileDirectory(home), { recursive: true });
        writeFileSync(join(profileDirectory(home), "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            extensions: [{
                path: join(process.cwd(), "examples/extensions/btw"),
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-pair-persist-"));
        const readyPath = join(home, "host-ready");
        const preferencePath = join(profileDirectory(home), "tui.json");
        let pane = "";
        mkdirSync(profileDirectory(home), { recursive: true });
        writeFileSync(join(profileDirectory(home), "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            extensions: [{
                path: join(process.cwd(), "examples/extensions/btw"),
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${shellQuote(join(home, ".vera"))} ${
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            if (hostProcess.exitCode === null) hostProcess.kill("SIGTERM");
            await hostProcess.exited;
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skipIf(!tmuxAvailable)(
    "tab picks the highlighted command without running it",
    async () => {
        const socket = `vera-command-tab-${process.pid}-${randomUUID()}`;
        const session = "command-tab";
        const home = mkdtempSync(join(tmpdir(), "vera-command-tab-"));
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
            sendText(socket, session, "/");
            await waitForVisiblePane(socket, session, "/fork");
            // Nothing chosen yet: the first row is where the list opened, not
            // a pick, so completing takes no command.
            sendKey(socket, session, "Tab");
            await Bun.sleep(200);
            pane = captureVisiblePane(socket, session);
            expect(pane).toContain("Rewind the active conversation");

            sendKey(socket, session, "Down");
            sendKey(socket, session, "Tab");
            // Typed, not run: a command that takes an argument is not
            // finished being typed when it is chosen.
            pane = await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) =>
                    visible.includes("/fork")
                    && !visible.includes("Rewind the active conversation"),
                "the chosen command alone in the composer",
            );
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(home, { recursive: true, force: true });
        }
    },
    30_000,
);

test.skipIf(!tmuxAvailable)(
    "an injected head stays hidden through the turns that follow",
    async () => {
        const socket = `vera-seat-stay-${process.pid}-${randomUUID()}`;
        const session = "seat-stay";
        const home = mkdtempSync(join(tmpdir(), "vera-seat-stay-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-injecting-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "first");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "AGENT SAW THE HEAD");
            expect(pane).not.toContain("system-note");

            // Every later turn rebuilds the transcript from the canonical
            // messages, which carry the head the band must keep hiding.
            for (const text of ["second", "third"]) {
                sendText(socket, session, text);
                sendKey(socket, session, "Enter");
                await waitForVisiblePane(socket, session, text);
                await Bun.sleep(400);
                pane = captureVisiblePane(socket, session);
                expect(pane).not.toContain("system-note");
            }
        } catch (error) {
            throw new Error(`${errorMessage(error)}\n\nLast pane:\n${pane}`);
        } finally {
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-clear-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-all-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-remove-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-left-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-quote-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-held-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
        const home = mkdtempSync(join(tmpdir(), "vera-seat-failure-"));
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
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
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
    await Bun.sleep(100);
    expect(capturePane(socket, session)).toContain("Confirm rewind");

    sendText(socket, session, "1");
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
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
    });
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

test.skipIf(!tmuxAvailable)(
    "the reviewer pane sets and clears both slots",
    async () => {
        const socket = `vera-reviewer-${process.pid}-${randomUUID()}`;
        const session = "reviewer";
        const home = mkdtempSync(join(tmpdir(), "vera-tui-reviewer-"));

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-reviewer-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/settings");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Reviewer");
            sendText(socket, session, "revie");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "the agent's own model");

            // Primary, then the failsafe behind it.
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Claude Haiku 4.5");
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            let pane = await waitForVisiblePane(
                socket,
                session,
                "anthropic/claude-haiku-4.5",
            );
            expect(pane).toContain("Failsafe");

            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "no failsafe reviewer");
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "gemma4:26b");
            expect(pane).toContain("anthropic/claude-haiku-4.5");

            // Clearing the primary drops the whole reviewer, failsafe included.
            sendKey(socket, session, "Up");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Use the agent's model");
            sendKey(socket, session, "Up");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(
                socket,
                session,
                "the agent's own model",
            );
            expect(pane).toContain("not set");
        } finally {
            runTmux(socket, ["kill-server"]);
            rmSync(home, { recursive: true, force: true });
        }
    },
);

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
