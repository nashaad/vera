import { expect, test } from "bun:test";

import { renderCliHelp } from "../clients/cli/help.ts";
import { runCli } from "../clients/cli/main.ts";
import type { TuiStartTarget } from "../clients/tui/session-target.ts";

test("@core --write-root starts a new session with the declared roots", async () => {
    const run = capture();
    expect(await runCli([
        "--write-root",
        "/mnt/shared",
        "--write-root",
        "/mnt/scratch",
    ], run.dependencies)).toBe(0);

    expect(run.targets).toEqual([{
        type: "create",
        workspace: process.cwd(),
        writeRoots: ["/mnt/shared", "/mnt/scratch"],
    }]);
});

test("--write-root combines with --bare and --prompt-only", async () => {
    for (const profile of ["bare", "prompt_only"] as const) {
        const run = capture();
        const flag = profile === "bare" ? "--bare" : "--prompt-only";
        expect(await runCli([
            flag,
            "--write-root",
            "/mnt/shared",
        ], run.dependencies)).toBe(0);
        expect(run.targets).toEqual([{
            type: "create",
            workspace: process.cwd(),
            startupProfile: profile,
            writeRoots: ["/mnt/shared"],
        }]);
    }
});

test("--write-root is refused everywhere but a new session", async () => {
    const cases: readonly (readonly string[])[] = [
        ["-c", "--write-root", "/mnt/shared"],
        ["resume", "session-1", "--write-root", "/mnt/shared"],
        ["attach", "agent-1", "--write-root", "/mnt/shared"],
        ["ls", "--write-root", "/mnt/shared"],
    ];
    for (const args of cases) {
        const run = capture();
        expect(await runCli(args, run.dependencies)).toBe(1);
        expect(run.err.join("")).toContain(
            "vera: --write-root can only be used when starting a new session.",
        );
    }

    const print = capture();
    expect(await runCli([
        "-p",
        "hello",
        "--write-root",
        "/mnt/shared",
    ], print.dependencies)).toBe(1);
    expect(print.err.join("")).toContain("vera -p does not take --write-root.");
    expect(print.targets).toEqual([]);
});

test("--write-root needs a value", async () => {
    const run = capture();
    expect(await runCli(["--write-root"], run.dependencies)).toBe(1);
    expect(run.err.join("")).toContain("vera: --write-root needs a directory.");
});

test("help names the write-root launch flag", () => {
    const help = renderCliHelp(120);
    expect(help).toContain("vera [--write-root <dir>] [--read-root <dir>] [--bare|--prompt-only]");
});

function capture() {
    const targets: TuiStartTarget[] = [];
    const out: string[] = [];
    const err: string[] = [];
    return {
        targets,
        out,
        err,
        dependencies: {
            runTui: async (target: TuiStartTarget) => {
                targets.push(target);
            },
            stdout: { write: (text: string) => out.push(text) },
            stderr: { write: (text: string) => err.push(text) },
        },
    };
}
