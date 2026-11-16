import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function expectDevTuiPacksBeforeLaunch(): void {
    const directory = mkdtempSync(join(tmpdir(), "vera-dev-tui-pack-"));
    const preload = join(directory, "preload.js");
    const launcher = resolve(import.meta.dir, "..", "..", "scripts", "dev-tui.ts");
    try {
        writeFileSync(preload, `
import { appendFileSync } from "node:fs";
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.kill = () => { throw new Error("Unexpected signal"); };
Bun.spawn = () => { throw new Error("Unexpected async subprocess"); };
Bun.spawnSync = (command) => {
    appendFileSync(process.env.DEV_TUI_PROBE_LOG, JSON.stringify(command) + "\\n");
    if (command[0] === process.execPath && command[1] === "run" && command[2] === "pack:release") {
        return { exitCode: Number(process.env.DEV_TUI_PROBE_PACK_EXIT) };
    }
    if (command[0] === "git") {
        return { exitCode: 1, stderr: Buffer.from("controlled worktree stop") };
    }
    throw new Error("Unexpected subprocess");
};
`);
        const run = (packExit: number) => {
            const log = join(directory, `commands-${packExit}.jsonl`);
            writeFileSync(log, "");
            const result = Bun.spawnSync([process.execPath, "--preload", preload, launcher], {
                cwd: directory,
                env: {
                    ...process.env,
                    HOME: directory,
                    VERA_HOME: join(directory, "home"),
                    DEV_TUI_PROBE_LOG: log,
                    DEV_TUI_PROBE_PACK_EXIT: String(packExit),
                },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const commands = readFileSync(log, "utf8").trim().split("\n")
                .filter(Boolean).map((line) => JSON.parse(line) as string[]);
            return { result, commands };
        };

        const failure = run(23);
        expect(failure.result.exitCode).toBe(23);
        expect(failure.commands).toEqual([[process.execPath, "run", "pack:release"]]);

        const success = run(0);
        expect(success.result.exitCode).toBe(1);
        expect(success.result.stderr.toString()).toContain("controlled worktree stop");
        expect(success.commands).toEqual([
            [process.execPath, "run", "pack:release"],
            ["git", "rev-parse", "--show-toplevel"],
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
