import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TERMINAL_RESTORE_SEQUENCE } from "../../clients/tui/terminal-restore.ts";

const repoRoot = join(import.meta.dir, "..", "..");

async function runChildScript(source: string): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
}> {
    const root = mkdtempSync(join(tmpdir(), "vera-crash-"));
    const scriptPath = join(root, "script.ts");
    writeFileSync(scriptPath, source);
    try {
        const child = Bun.spawn([process.execPath, scriptPath], {
            stdout: "pipe",
            stderr: "ignore",
        });
        const stdout = await new Response(child.stdout).text();
        return { exitCode: await child.exited, stdout };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("a TUI crash still restores the terminal on the way out", async () => {
    const result = await runChildScript(`
        import { installTerminalRestoreOnExit } from ${
        JSON.stringify(join(repoRoot, "clients/tui/terminal-restore.ts"))
    };
        installTerminalRestoreOnExit({ fd: 1, isTTY: true });
        throw new Error("injected renderer crash");
    `);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("\x1b[?1049l");
    expect(result.stdout).toContain("\x1b[?25h");
});

test("the restore sequence leaves the alternate screen and shows the cursor", () => {
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?1049l");
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?25h");
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?2004l");
});

test("the crash guard keeps the host process alive and logs the cause", async () => {
    const result = await runChildScript(`
        import { installHostCrashGuard } from ${
        JSON.stringify(join(repoRoot, "clients/host/crash-guard.ts"))
    };
        installHostCrashGuard((entry) => {
            console.log(JSON.stringify(entry));
        });
        Promise.reject(new Error("injected bookkeeping failure"));
        setTimeout(() => {
            queueMicrotask(() => {
                throw new Error("injected sync failure");
            });
            setTimeout(() => {
                console.log("host still alive");
                process.exit(0);
            }, 20);
        }, 20);
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("host_unhandled_rejection");
    expect(result.stdout).toContain("injected bookkeeping failure");
    expect(result.stdout).toContain("host_uncaught_exception");
    expect(result.stdout).toContain("injected sync failure");
    expect(result.stdout).toContain("host still alive");
});
