import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const tmuxAvailable = canRunTmux();

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
            sendText(socket, session, "start streaming");
            sendKey(socket, session, "Enter");

            pane = await waitForPane(socket, session, "PARTIAL xxxxx");
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

function sendText(socket: string, session: string, value: string): void {
    runTmux(socket, ["send-keys", "-t", session, "-l", value]);
}

function sendKey(socket: string, session: string, key: string): void {
    runTmux(socket, ["send-keys", "-t", session, key]);
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

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
