import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function running(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

test("one line up holds through output, and one line down resumes follow", async () => {
    const root = "/private/tmp/vera-dev";
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "tuifix2-scroll-"));
    const home = join(directory, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "stub",
        model: "fixture",
        approval_mode: "auto",
        providers: {
            stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" },
        },
    }));
    const socket = join(directory, "tmux.sock");
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        USER: process.env.USER ?? "test",
        LOGNAME: process.env.USER ?? "test",
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        TMPDIR: directory,
        VERA_HOME: home,
        VERA_DEV_INSTANCE: "tuifix2 dev",
    };
    const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", socket, ...args], {
        cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    const run = (...args: string[]): string => {
        const result = tmux(...args);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString();
    };
    const pane = (): string => run("capture-pane", "-p", "-t", "scroll");
    const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (!predicate()) {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}:\n${pane()}`);
            await Bun.sleep(50);
        }
    };
    let panePid = 0;
    let serverPid = 0;
    try {
        run("-f", "/dev/null", "new-session", "-d", "-s", "scroll", "-x", "120", "-y", "40",
            "-c", process.cwd(), "/bin/sh", "-c", 'exec "$1" "$2" 2>"$3"', "scroll",
            process.execPath, join(process.cwd(), "test/support/tui-single-line-child.ts"), join(directory, "stderr"));
        panePid = Number(run("display-message", "-p", "-t", "scroll", "#{pane_pid}"));
        serverPid = Number(run("display-message", "-p", "-t", "scroll", "#{pid}"));
        expect(panePid).toBeGreaterThan(1);
        expect(serverPid).toBeGreaterThan(1);
        await waitFor(() => pane().includes("Start a conversation"), "the TUI");
        run("send-keys", "-t", "scroll", "-l", "long reply");
        run("send-keys", "-t", "scroll", "Enter");
        await waitFor(() => pane().includes("LINE300"), "the last line");
        await Bun.sleep(600);
        const bottom = pane().split("\n")[1]!.slice(0, 100).trimEnd();

        run("send-keys", "-t", "scroll", "C-Up");
        await Bun.sleep(700);
        const up = pane();
        expect(up).toContain("Jump to bottom");
        expect(up.split("\n")[2]!.slice(0, 100).trimEnd()).toBe(bottom);

        run("send-keys", "-t", "scroll", "C-Down");
        await waitFor(() => !pane().includes("Jump to bottom"), "follow after one line down");
        process.kill(panePid, "SIGUSR1");
        await waitFor(() => existsSync(join(home, "appended-1")), "the first update");
        await waitFor(() => pane().includes("APPENDED-LINE-1-5"), "the followed update");
        expect(pane()).not.toContain("Jump to bottom");

        run("send-keys", "-t", "scroll", "C-Up");
        await Bun.sleep(500);
        const heldTop = pane().split("\n")[1]!.slice(0, 100).trimEnd();
        expect(pane()).toContain("Jump to bottom");
        process.kill(panePid, "SIGUSR1");
        await waitFor(() => existsSync(join(home, "appended-2")), "the second update");
        await Bun.sleep(700);
        const held = pane();
        expect(held).toContain("Jump to bottom");
        expect(held.split("\n")[1]!.slice(0, 100).trimEnd()).toBe(heldTop);
        expect(held).not.toContain("APPENDED-LINE-2-5");
    } finally {
        tmux("send-keys", "-t", "scroll", "C-c");
        await Bun.sleep(100);
        tmux("send-keys", "-t", "scroll", "C-c");
        tmux("kill-server");
        for (const pid of [panePid, serverPid]) {
            if (pid <= 1) continue;
            for (let attempt = 0; attempt < 100 && running(pid); attempt += 1) {
                await Bun.sleep(50);
            }
            expect(running(pid)).toBe(false);
        }
    }
}, 45_000);
