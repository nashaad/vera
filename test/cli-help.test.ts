import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../clients/cli/main.ts";
import { CLI_COMMANDS, DOCS_DIR } from "../clients/cli/help.ts";

function capture() {
    const out: string[] = [];
    const err: string[] = [];
    let started = false;
    return {
        out,
        err,
        started: () => started,
        dependencies: {
            runTui: async () => {
                started = true;
            },
            doctor: async () => {
                throw new Error("help must not run the command");
            },
            stdout: { write: (text: string) => out.push(text) },
            stderr: { write: (text: string) => err.push(text) },
        },
    };
}

test("--help and -h render one overview with a docs pointer", async () => {
    const run = capture();
    expect(await runCli(["--help"], run.dependencies)).toBe(0);
    expect(await runCli(["-h"], run.dependencies)).toBe(0);
    expect(run.out[0]).toBe(run.out[1]);
    expect(run.out[0]).toContain("Vera coding agent");
    expect(run.out[0]).toContain("vera attach <agent-id>");
    expect(run.out[0]).toContain(`Docs: ${join(DOCS_DIR, "index.md")}`);
    expect(run.started()).toBe(false);
});

test("a command's --help shows only that command's rows and its docs file", async () => {
    const run = capture();
    expect(await runCli(["library", "--help"], run.dependencies)).toBe(0);
    expect(run.out[0]).toContain("vera library list");
    expect(run.out[0]).toContain("vera library add <provider/model>");
    expect(run.out[0]).toContain("vera library remove <name|id>");
    expect(run.out[0]).not.toContain("vera attach");
    expect(run.out[0]).toContain(`Docs: ${join(DOCS_DIR, "models.md")}`);
});

test("a command's -h prints help instead of running the command", async () => {
    const run = capture();
    expect(await runCli(["doctor", "-h"], run.dependencies)).toBe(0);
    expect(run.out[0]).toContain("vera doctor --check-providers");
    expect(run.out[0]).toContain("runtime-and-worktrees.md");
});

test("a command without its own page points at the docs index", async () => {
    const run = capture();
    expect(await runCli(["ls", "--help"], run.dependencies)).toBe(0);
    expect(run.out[0]).toContain("vera ls [--all]");
    expect(run.out[0]).toContain(`Docs: ${join(DOCS_DIR, "index.md")}`);
});

test("an unknown command with --help prints usage", async () => {
    const run = capture();
    expect(await runCli(["nonsense", "--help"], run.dependencies)).toBe(1);
    expect(run.err.join("")).toContain("Run 'vera --help'");
});

test("every docs pointer names a file in docs/", () => {
    expect(existsSync(join(DOCS_DIR, "index.md"))).toBe(true);
    for (const command of CLI_COMMANDS) {
        if (command.docs === undefined) continue;
        expect(existsSync(join(DOCS_DIR, command.docs))).toBe(true);
    }
});

test("help wraps to the terminal width at word breaks", async () => {
    const out: string[] = [];
    const narrow = { columns: 60, write: (text: string) => out.push(text) };
    expect(await runCli(["--help"], { stdout: narrow })).toBe(0);
    const lines = out.join("").split("\n").filter((line) => !line.startsWith("Docs:"));
    for (const line of lines) expect([line, line.length <= 60]).toEqual([line, true]);
    expect(out.join("")).toContain("  vera doctor --check-providers");
});

test("the help word points at the flag", async () => {
    const run = capture();
    expect(await runCli(["help"], run.dependencies)).toBe(0);
    expect(await runCli(["help", "doctor"], run.dependencies)).toBe(0);
    expect(run.out[0]).toContain("'vera <command> --help'");
    expect(run.out[1]).toContain("'vera doctor --help'");
    expect(run.started()).toBe(false);
});
