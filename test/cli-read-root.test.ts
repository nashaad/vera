import { expect, test } from "bun:test";

import { renderCliHelp } from "../clients/cli/help.ts";
import { runCli } from "../clients/cli/main.ts";
import type { TuiStartTarget } from "../clients/tui/session-target.ts";

test("@core --read-root starts a new session with the declared roots", async () => {
    const run = capture();
    expect(await runCli([
        "--read-root",
        "/mnt/reference",
        "--read-root",
        "/mnt/docs",
    ], run.dependencies)).toBe(0);

    expect(run.targets).toEqual([{
        type: "create",
        workspace: process.cwd(),
        readRoots: ["/mnt/reference", "/mnt/docs"],
    }]);
});

test("@core --read-root and --write-root together keep each list on its own", async () => {
    const run = capture();
    expect(await runCli([
        "--write-root",
        "/mnt/scratch",
        "--read-root",
        "/mnt/reference",
        "--write-root",
        "/mnt/shared",
    ], run.dependencies)).toBe(0);

    expect(run.targets).toEqual([{
        type: "create",
        workspace: process.cwd(),
        writeRoots: ["/mnt/scratch", "/mnt/shared"],
        readRoots: ["/mnt/reference"],
    }]);
});

test("--read-root combines with --bare and --prompt-only", async () => {
    for (const profile of ["bare", "prompt_only"] as const) {
        const run = capture();
        const flag = profile === "bare" ? "--bare" : "--prompt-only";
        expect(await runCli([
            flag,
            "--read-root",
            "/mnt/reference",
        ], run.dependencies)).toBe(0);
        expect(run.targets).toEqual([{
            type: "create",
            workspace: process.cwd(),
            startupProfile: profile,
            readRoots: ["/mnt/reference"],
        }]);
    }
});

test("--read-root is refused everywhere but a new session", async () => {
    const cases: readonly (readonly string[])[] = [
        ["-c", "--read-root", "/mnt/reference"],
        ["resume", "session-1", "--read-root", "/mnt/reference"],
        ["attach", "agent-1", "--read-root", "/mnt/reference"],
        ["ls", "--read-root", "/mnt/reference"],
    ];
    for (const args of cases) {
        const run = capture();
        expect(await runCli(args, run.dependencies)).toBe(1);
        expect(run.err.join("")).toContain(
            "vera: --read-root can only be used when starting a new session.",
        );
    }

    const print = capture();
    expect(await runCli([
        "-p",
        "hello",
        "--read-root",
        "/mnt/reference",
    ], print.dependencies)).toBe(1);
    expect(print.err.join("")).toContain("vera -p does not take --read-root.");
    expect(print.targets).toEqual([]);
});

test("--read-root needs a value", async () => {
    const run = capture();
    expect(await runCli(["--read-root"], run.dependencies)).toBe(1);
    expect(run.err.join("")).toContain("vera: --read-root needs a directory.");

    const trailing = capture();
    expect(await runCli(["--write-root", "/mnt/shared", "--read-root"], trailing.dependencies)).toBe(1);
    expect(trailing.err.join("")).toContain("vera: --read-root needs a directory.");
});

test("help names the read-root launch flag", () => {
    expect(renderCliHelp(120)).toContain("--read-root <dir>");
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
