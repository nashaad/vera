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

const tmuxAvailable = canRunTmux();

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
                36,
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
                "Learn Vera controls and commands",
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
            expect(pane).toContain("Settings");
            expect(pane).toContain("Switch model");
            expect(pane).not.toContain("Rewind the active conversation");
            sendText(socket, session, "switch model");
            pane = await waitForVisiblePane(socket, session, "⌕  switch model");
            expect(pane).toContain("Switch model");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Select model");
            expect(pane).not.toContain("⌕  switch model");
            sendKey(socket, session, "Escape");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (visible) => visible.includes("Message Vera"),
                "model picker to close",
            );
            sendText(socket, session, "/palette");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Commands");
            // "recolor" is in no command name, so only description search finds
            // it: the reason the palette earns a place beside the composer.
            sendText(socket, session, "recolor");
            pane = await waitForVisiblePane(
                socket,
                session,
                "⌕  recolor",
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
            expect(pane).toContain("current-model · reasoning");

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
            await waitForVisiblePane(socket, session, "⌕  hello");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Say hello from an extension",
            );
            expect(pane).toContain("Extensions");
            expect(pane).toContain("⌕  hello");
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
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/model openrouter/other");
            sendKey(socket, session, "Enter");
            // The request itself is a transient toast, so the durable proof
            // that it landed is the status line reporting the new model.
            await waitForVisiblePane(
                socket,
                session,
                "other · reasoning",
            );
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
            // Two rows since the status split across footer lines: the
            // lifecycle hint, then the model details. Waiting for them joined
            // was waiting for a line that no longer renders.
            await waitForVisiblePane(socket, session, "ready · ctrl+p commands");
            sendKey(socket, session, "Right");
            sendKey(socket, session, "Right");
            sendText(socket, session, "themes");
            pane = await waitForVisiblePane(socket, session, "⌕  themes");
            expect(pane).toContain("/themes");
            expect(pane).not.toContain("/rename");
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
                "Connection error: Host sent a non-contiguous agent update sequence",
            );
            expect(pane).toContain("disconnected · /reconnect host");
            expect(pane).not.toContain("working…");
            expect(pane).not.toContain("stopping");

            sendText(socket, session, "/reconnect");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Host reconnected.");
            expect(pane).toContain("ready · ctrl+p commands");
            expect(pane).not.toContain("disconnected · /reconnect host");

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
            expect(pane).toContain(
                "+ Explored · 37 lines · Read package.json  ctrl+e details",
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
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
            expect(JSON.parse(readFileSync(join(home, ".vera", "tui.json"), "utf8")))
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
            // "reasoning max" wait below is the real guard: the status line
            // only reads that way if Down moved the selection off High.
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "reasoning max",
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
                    shellQuote(process.execPath)
                } run test/support/tui-child.ts`,
            ]);

            pane = await waitForPane(socket, session, "test · reasoning high");
            expect(pane).toContain("Start a conversation");
            expect(pane).not.toContain("shift+enter newline");
            sendText(socket, session, "start streaming");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "enter queue");
            expect(pane).toMatch(/[░▒▓█]{7} (thinking|responding) · \d+s/);
            expect(pane).toContain("esc redirect/stop");

            pane = await waitForPane(socket, session, "PARTIAL xxxxx");
            expect(pane).toMatch(/[░▒▓█]{7} responding · \d+s/);
            expect(pane).toContain("esc redirect/stop");
            // No fold marker: this turn reasons without producing any summary
            // text, so there is nothing behind the line to open.
            expect(pane).toMatch(/(?<![+-] )Thought: \d+\.\d+s/);
            sendText(socket, session, "redirect now");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "queued · redirect now");
            sendKey(socket, session, "Escape");

            pane = await waitForPane(socket, session, "STEER WORKED");
            expect(pane).toContain("PARTIAL xxxxx");
            expect(pane).toContain("redirect now");
            expect(pane).not.toContain("FIRST-END");
            // The estimate stands while the request is in flight, so the
            // provider's own count only replaces it once the turn ends.
            pane = await waitForPane(socket, session, "auto · ctx 25%");

            // The second turn reasons, so its summary carries a fold that
            // ctrl+o opens over a row already drawn.
            expect(pane).toMatch(/\+ Thought: \d+\.\d+s/);
            expect(pane).not.toContain("WEIGHING THE ORDERINGS");
            sendKey(socket, session, "C-o");
            pane = await waitForPane(socket, session, "WEIGHING THE ORDERINGS");
            expect(pane).toMatch(/- Thought: \d+\.\d+s/);
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
            expect(pane).toContain("+ Ran · 11 lines · printf");
            expect(pane).toContain("ctrl+e details");
            expect(pane).not.toContain("TOOL_DETAIL_09");

            sendKey(socket, session, "C-e");
            pane = await waitForVisiblePane(socket, session, "TOOL_DETAIL_09");
            expect(pane).toContain("- Ran · 11 lines  ctrl+e details");
            expect(pane).toContain("TOOL DETAILS COMPLETED");

            sendText(socket, session, "run one short action");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SHORT TOOL COMPLETED");
            expect(pane).toContain("SHORT_DETAIL");

            sendKey(socket, session, "C-e");
            pane = await waitForVisiblePane(socket, session, "+ Ran · 2 lines");
            expect(pane.match(/SHORT_DETAIL/g)).toHaveLength(1);
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
            expect(pane).toContain("+ Ran · ");
            expect(pane).toContain("· env AUTO_REVIEW=ran  ctrl+e details");
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
            pane = await waitForVisiblePane(
                socket,
                session,
                "Session and always are unavailable.",
            );
            expect(pane).toContain("Allow once");
            expect(pane).not.toContain("$ grep");

            sendKey(socket, session, "3");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => !current.includes("Allow once"),
                "closed approval",
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
                "1  Stable",
            );
            expect(pane).toContain("Which release channel");
            expect(pane).toContain("2  Preview");
            expect(pane).toContain("3  Nightly");
            expect(pane).not.toContain("question waiting");
            expect(pane).not.toContain("gpt-5.6-sol");
            // The reproduction for the status-line collision: above the short
            // terminal threshold the overlay clears the status line's row, so
            // its final line of key hints survives instead of being drawn over.
            // The 42x10 approval test covers the other side of the threshold,
            // where the row goes back to the content.
            expect(pane).toContain("esc cancel");

            sendText(socket, session, "2");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Selection received: preview-channel",
            );
            expect(pane).not.toContain("esc cancel");

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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_TEST_COPIED_TEXT_PATH=${shellQuote(copiedTextPath)} ${
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

            const styledPane = captureVisiblePaneWithStyles(socket, session);
            expect(styledPane).toMatch(
                new RegExp(`\\x1b\\[48;2;\\d+;\\d+;\\d+m${selectedText}`),
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
    height = 30,
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
        } ${exported}${shellQuote(process.execPath)} run ${
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
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
    "real TUI opens rewind through a detached resident host",
    async () => {
        const socket = `vera-resident-rewind-${process.pid}-${randomUUID()}`;
        const session = "tui";
        const home = mkdtempSync(join(tmpdir(), "vera-resident-rewind-"));
        let pane = "";
        mkdirSync(join(home, ".vera"), { recursive: true });
        writeFileSync(join(home, ".vera", "config.json"), `${JSON.stringify({
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
                `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
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
                14,
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
    "a seated model answers in its own column, and its note stays off the band",
    async () => {
        const socket = `vera-multi-seat-${process.pid}-${randomUUID()}`;
        const session = "multi-seat";
        const home = mkdtempSync(join(tmpdir(), "vera-multi-seat-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-multi-seat-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");

            // The pool owns the list the argument completes from.
            sendText(socket, session, "/add ");
            pane = await waitForVisiblePane(socket, session, "advisor");

            sendText(socket, session, "advisor as m1");
            sendKey(socket, session, "Enter");
            // Seating fills the column before the seat has said anything.
            pane = await waitForVisiblePane(socket, session, "Seated. Ask with @m1");
            expect(pane).toContain("m1 (faux-advisor)");

            // An addressed message goes to the seat alone: the ask and the
            // answer are filed beside the transcript, not in it.
            sendText(socket, session, "@m1 which ordering");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "SEAT SAW");
            expect(pane).toContain("you \u2192 @m1");

            // The next message to the agent carries the seating note and the
            // reply, and the band shows only what was typed.
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
    "@all reaches every seat and the agent in one message",
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
                "test/support/tui-multi-seat-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/add advisor as m1");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @m1");
            sendText(socket, session, "/add second as m2");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @m2");

            sendText(socket, session, "@all which ordering");
            sendKey(socket, session, "Enter");
            // Both seats answer in the column, and the agent answers in the
            // transcript: `@all` is everyone, not only the seats.
            pane = await waitForVisiblePane(socket, session, "AGENT ANSWERED");
            expect(pane).toContain("m1 (faux-advisor)");
            expect(pane).toContain("m2 (faux-second)");
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

test.skipIf(!tmuxAvailable)(
    "removing a seat completes its name and says so in its column",
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
                "test/support/tui-multi-seat-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/add advisor as frosty");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @frosty");
            // A second seat, so the column outlives the one being removed.
            sendText(socket, session, "/add second as m2");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @m2");

            // The argument completes from the names the extension published,
            // so a seat can be removed without spelling it out.
            sendText(socket, session, "/remove ");
            pane = await waitForVisiblePane(socket, session, "frosty");
            // Tab chooses the highlighted name, the same as Enter does.
            sendKey(socket, session, "Tab");
            await waitForVisiblePane(socket, session, "/remove frosty");
            sendKey(socket, session, "Enter");
            // The column says who is in the room, so it says when someone is
            // not: an ended lane should not read as one gone quiet.
            pane = await waitForVisiblePane(
                socket,
                session,
                "Left the conversation.",
            );
            expect(pane).toContain("@frosty left");
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
                "test/support/tui-multi-seat-child.ts",
                100,
                30,
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/add broken as m1");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "Seated. Ask with @m1");

            sendText(socket, session, "@m1 you there");
            sendKey(socket, session, "Enter");
            // In the column, under the seat's own label: a failed round is a
            // gap in that conversation, not a notice about somewhere else.
            pane = await waitForVisiblePane(socket, session, "Could not answer");
            expect(pane).toContain("you \u2192 @m1");
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
            readFileSync(join(home, ".vera", "host.json"), "utf8"),
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
