import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

export interface ReopenTmux {
    readonly home: string;
    text(value: string): void;
    key(value: string): void;
    pane(): string;
    waitFor(predicate: (pane: string) => boolean, description: string): Promise<string>;
    close(): Promise<void>;
}

export function startReopenTmux(mode: string): ReopenTmux {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "rp-"));
    const home = join(directory, "home");
    mkdirSync(home);
    const socket = join(directory, "tmux.sock");
    const fixture = join(import.meta.dir, "tui-reopen-child.ts");
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        USER: process.env.USER ?? "test",
        LOGNAME: process.env.USER ?? "test",
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        VERA_HOME: home,
        VERA_DEV_INSTANCE: "reopen dev",
        TMPDIR: directory,
    };
    const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", socket, ...args], {
        cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(mode)} 2>${quote(join(directory, "stderr"))}`;
    const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-x", "120", "-y", "40", "-c", process.cwd(), command);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());
    const pidResult = tmux("display-message", "-p", "-t", "test", "#{pane_pid}");
    const pid = Number(pidResult.stdout.toString().trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) {
        tmux("kill-server");
        throw new Error(`Cannot identify test TUI process: ${pidResult.stderr.toString()}`);
    }
    const pane = (): string => tmux("capture-pane", "-p", "-t", "test").stdout.toString();
    return {
        home,
        text(value): void { tmux("send-keys", "-t", "test", "-l", value); },
        key(value): void { tmux("send-keys", "-t", "test", value); },
        pane,
        async waitFor(predicate, description): Promise<string> {
            const deadline = Date.now() + 10_000;
            let screen = "";
            while (Date.now() < deadline) {
                screen = pane();
                if (predicate(screen)) return screen;
                await Bun.sleep(50);
            }
            throw new Error(`Timed out waiting for ${description}:\n${screen}`);
        },
        async close(): Promise<void> {
            tmux("send-keys", "-t", "test", "C-c");
            await Bun.sleep(100);
            tmux("send-keys", "-t", "test", "C-c");
            for (let attempt = 0; attempt < 40; attempt += 1) {
                try { process.kill(pid, 0); } catch { break; }
                await Bun.sleep(50);
            }
            try { process.kill(pid, "SIGTERM"); } catch {}
            tmux("kill-server");
            for (let attempt = 0; attempt < 40; attempt += 1) {
                try { process.kill(pid, 0); } catch { return; }
                await Bun.sleep(50);
            }
            throw new Error(`TUI process ${pid} did not exit`);
        },
    };
}
