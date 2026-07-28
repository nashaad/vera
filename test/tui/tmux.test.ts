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
    "the bundled preset uses only public client extension seams",
    async () => {
        const socket = `vera-user-preset-${process.pid}-${randomUUID()}`;
        const session = "user-preset";
        const home = mkdtempSync(join(tmpdir(), "vera-user-preset-"));
        let pane = "";

        try {
            startTuiSession(
                socket,
                session,
                home,
                "test/support/tui-user-preset-child.ts",
            );
            await waitForVisiblePane(socket, session, "Start a conversation");
            sendText(socket, session, "/preset");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Model presets");
            expect(pane).toContain("Slot 1");
            expect(pane).toContain("empty");

            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "kimi-k3 · low");
            expect(pane).toContain("Slot 1");
            sendKey(socket, session, "Escape");
            await waitForVisiblePane(socket, session, "Start a conversation");

            sendText(socket, session, "/model openrouter/other");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "model change requested",
            );
            sendText(socket, session, "/preset");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(socket, session, "kimi-k3 · low");
            sendKey(socket, session, "Enter");
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const saved = JSON.parse(readFileSync(
                    join(home, "user-preset-settings.json"),
                    "utf8",
                ));
                if (saved.model === "moonshotai/kimi-k3") break;
                await Bun.sleep(20);
            }
            expect(JSON.parse(readFileSync(
                join(home, "user-preset-settings.json"),
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
            expect(pane).toContain("disconnected · /resume reconnect");
            expect(pane).not.toContain("working…");
            expect(pane).not.toContain("stopping");

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
            expect(pane).toContain("∗ read package.json");

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
                "Could not fork this session: fork timed out",
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
            expect(pane).toContain("current ·");
            expect(pane).toContain("1h ago · vera");
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
            expect(pane).toContain("moved to");
            sendKey(socket, session, "Escape");
            sendKey(socket, session, "C-c");
            await waitForSessionExit(socket, session);
            expect(readFileSync(
                join(home, "trash-session-result.txt"),
                "utf8",
            )).toBe("saved-session\nlist calls 2");
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
            expect(pane).toContain("That con");
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

            sendText(socket, session, "/reasoning");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Reasoning");
            expect(pane).toContain("High");

            // The selected row is now a background highlight rather than a "›"
            // caret, so it does not show up in tmux's text-only capture. The
            // "reasoning change requested: max" wait below is the real guard:
            // it only appears if Down moved the selection off High before Enter.
            sendKey(socket, session, "Down");
            sendKey(socket, session, "Enter");
            await waitForVisiblePane(
                socket,
                session,
                "reasoning change requested: max",
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
            expect(pane).toMatch(/\+ Thought: \d+\.\d+s/);
            sendText(socket, session, "redirect now");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "queued · redirect now");
            sendKey(socket, session, "Escape");

            pane = await waitForPane(socket, session, "STEER WORKED");
            expect(pane).toContain("PARTIAL xxxxx");
            expect(pane).toContain("redirect now");
            expect(pane).not.toContain("FIRST-END");
            expect(pane).toContain("auto · ctx 25%");
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
            expect(pane).toContain("∗ bash env AUTO_REVIEW=ran");
            expect(pane).toContain("auto");
            expect(pane).not.toContain("Tool approval");
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
            expect(pane).toContain("Tool approval");
            expect(pane).toContain("$ grep");

            for (let index = 0; index < 20; index += 1) {
                sendKey(socket, session, "Down");
            }
            pane = await waitForVisiblePane(
                socket,
                session,
                "full user permissions",
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
            expect(pane).toContain("1  Allow once");
            expect(pane).toContain("3  Deny");
            expect(pane).not.toContain("Allow similar");
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
): void {
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
        `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} ${
            shellQuote(process.execPath)
        } run ${shellQuote(childPath)}`,
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

function sendText(socket: string, session: string, value: string): void {
    runTmux(socket, ["send-keys", "-t", session, "-l", value]);
}

function sendKey(socket: string, session: string, key: string): void {
    runTmux(socket, ["send-keys", "-t", session, key]);
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
        (current) => current.includes("Rewind: select a point")
            && current.includes("second request"),
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
