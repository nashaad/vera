import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { killTmuxServer } from "../../support/kill-tmux-server.ts";
import { ownTmuxServer } from "../../support/uat-process-owner.ts";

function firstLine(pane: string): { row: number; line: string } {
    const rows = pane.split("\n");
    for (let row = 0; row < rows.length; row += 1) {
        const line = /\bLINE\d{3}\b/.exec(rows[row]!)?.[0];
        if (line !== undefined) return { row, line };
    }
    throw new Error(`No transcript line in pane:\n${pane}`);
}

test("tmux resize keeps the top source line from 120 to 70 and back", async () => {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, "resize-tmux-"));
    const socket = `vera-resize-${randomUUID()}`;
    const tmux = (...args: string[]): string => {
        const result = Bun.spawnSync(["tmux", "-L", socket, ...args], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString();
    };
    ownTmuxServer(socket);
    let serverPid: number | undefined;
    let panePid: number | undefined;
    try {
        tmux("-f", "/dev/null", "new-session", "-d", "-s", "resize", "-x", "120", "-y", "40",
            "-c", process.cwd(), "-e", `VERA_HOME=${home}`, "-e", "VERA_DEV_INSTANCE=resize dev",
            process.execPath, join(process.cwd(), "test/support/tui-resize-anchor-child.ts"));
        serverPid = Number(tmux("display-message", "-p", "-t", "resize", "#{pid}"));
        panePid = Number(tmux("display-message", "-p", "-t", "resize", "#{pane_pid}"));
        const capture = (): string => tmux("capture-pane", "-p", "-t", "resize");
        const deadline = Date.now() + 15_000;
        while (!capture().includes("LINE300")) {
            if (Date.now() >= deadline) throw new Error(`TUI did not start:\n${capture()}`);
            await Bun.sleep(50);
        }
        for (let press = 0; press < 14; press += 1) {
            tmux("send-keys", "-t", "resize", "C-u");
            await Bun.sleep(40);
        }
        await Bun.sleep(200);
        const before = firstLine(capture());
        for (const width of [70, 120]) {
            tmux("resize-window", "-t", "resize", "-x", String(width), "-y", "40");
            await Bun.sleep(300);
            expect(firstLine(capture())).toEqual(before);
        }
    } finally {
        killTmuxServer(socket);
        for (const pid of [serverPid, panePid]) {
            if (pid === undefined) continue;
            let running = true;
            for (let attempt = 0; attempt < 50; attempt += 1) {
                try {
                    process.kill(pid, 0);
                } catch {
                    running = false;
                    break;
                }
                await Bun.sleep(50);
            }
            expect(running).toBe(false);
        }
    }
}, 30_000);
