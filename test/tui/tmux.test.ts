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

            sendText(socket, session, "/reasoning");
            sendKey(socket, session, "Enter");
            pane = await waitForVisiblePane(socket, session, "Reasoning");
            expect(pane).toContain("High");

            sendKey(socket, session, "Down");
            await waitForVisiblePane(socket, session, "› Max");
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

            pane = await waitForPane(socket, session, "Start a conversation");
            expect(pane).toContain("test · reasoning high");
            sendText(socket, session, "start streaming");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "enter queue");
            expect(pane).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (thinking|responding) · \d+s/);
            expect(pane).toContain("esc interrupt");

            pane = await waitForPane(socket, session, "PARTIAL xxxxx");
            expect(pane).toContain("Responding · test · provider loading");
            expect(pane).toMatch(/\+ Thought: \d+\.\d+s/);
            sendText(socket, session, "redirect now");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "queued · redirect now");
            sendKey(socket, session, "Escape");

            pane = await waitForPane(socket, session, "STEER WORKED");
            expect(pane).toContain("PARTIAL xxxxx");
            expect(pane).toContain("redirect now");
            expect(pane).not.toContain("FIRST-END");
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
            await waitForPane(interruptSocket, "interrupt", "Rewind — select a point");
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
                "[1]once",
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
            expect(pane).toContain("[1]once");
            expect(pane).not.toContain("$ grep");

            sendKey(socket, session, "3");
            await waitForVisiblePaneWhere(
                socket,
                session,
                (current) => !current.includes("[1]once"),
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
                10,
            );
            pane = await waitForVisiblePane(
                socket,
                session,
                "[1-3] choose · [esc] cancel",
            );
            expect(pane).toContain("Which release channel");
            expect(pane).toContain("[1] Stable");
            expect(pane).toContain("[2] Preview");
            expect(pane).toContain("[3] Nightly");

            sendText(socket, session, "2");
            pane = await waitForVisiblePane(
                socket,
                session,
                "Selection received: preview-channel",
            );
            expect(pane).not.toContain("[1-3] choose");

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
            approval_mode: "approve_for_me",
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
    let pane = await waitForPane(
        socket,
        session,
        "/rewind  Rewind the active conversation",
    );
    expect(pane).toContain("Commands");
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
        (current) => current.includes("Rewind — select a point")
            && current.includes("›")
            && current.includes("second request"),
        "loaded rewind timeline",
    );
    expect(pane).toContain("Rewind — select a point");
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
