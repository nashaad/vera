import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

function running(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

test("Down crosses the resume heading and Enter opens the recent row", async () => {
    const root = "/private/tmp/vera-dev";
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "tuifix2-picker-"));
    const home = join(directory, "home");
    mkdirSync(home);
    const socket = join(directory, "tmux.sock");
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory,
        USER: process.env.USER ?? "test", LOGNAME: process.env.USER ?? "test",
        SHELL: "/bin/sh", TERM: "xterm-256color", LANG: "en_US.UTF-8",
        TMPDIR: directory, VERA_HOME: home, VERA_DEV_INSTANCE: "tuifix2 dev",
    };
    const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", socket, ...args], {
        cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    const run = (...args: string[]): string => {
        const result = tmux(...args);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString();
    };
    const pane = (): string => run("capture-pane", "-p", "-t", "picker");
    const waitFor = async (text: string): Promise<string> => {
        const deadline = Date.now() + 10_000;
        let screen = "";
        while (Date.now() < deadline) {
            screen = pane();
            if (screen.includes(text)) return screen;
            await Bun.sleep(50);
        }
        throw new Error(`Timed out waiting for ${text}:\n${screen}`);
    };
    let panePid = 0;
    let serverPid = 0;
    try {
        run("-f", "/dev/null", "new-session", "-d", "-s", "picker", "-x", "120", "-y", "40",
            "-c", process.cwd(), "/bin/sh", "-c", 'exec "$1" "$2" 2>"$3"', "picker",
            process.execPath, join(process.cwd(), "test/support/tui-session-section-child.ts"), join(directory, "stderr"));
        panePid = Number(run("display-message", "-p", "-t", "picker", "#{pane_pid}"));
        serverPid = Number(run("display-message", "-p", "-t", "picker", "#{pid}"));
        expect(panePid).toBeGreaterThan(1);
        expect(serverPid).toBeGreaterThan(1);
        await waitFor("Message Vera");
        run("send-keys", "-t", "picker", "-l", "/resume");
        run("send-keys", "-t", "picker", "Enter");
        const picker = await waitFor("Continue the theme picker");
        expect(picker).toContain("IDLE");
        expect(picker).toContain("RECENT");
        run("send-keys", "-t", "picker", "Down");
        run("send-keys", "-t", "picker", "Enter");
        const opened = await waitFor("RESUMED HISTORY LOADED");
        expect(opened).not.toContain("RECENT");
    } finally {
        tmux("send-keys", "-t", "picker", "C-c");
        await Bun.sleep(100);
        tmux("send-keys", "-t", "picker", "C-c");
        tmux("kill-server");
        for (const pid of [panePid, serverPid]) {
            if (pid <= 1) continue;
            for (let attempt = 0; attempt < 100 && running(pid); attempt += 1) {
                await Bun.sleep(50);
            }
            expect(running(pid)).toBe(false);
        }
    }
}, 30_000);
