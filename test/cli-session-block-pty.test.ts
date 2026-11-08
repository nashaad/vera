import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { veraBlockedDirectoryIn, veraRuntimeDirectoryIn } from "../src/profile-paths.ts";
import { isSessionBlockedSync } from "../src/host/session-block.ts";

const CLI = join(import.meta.dir, "..", "clients", "cli", "main.ts");
const SESSION_ID = "pty-block-session";

interface Fixture {
    readonly root: string;
    readonly home: string;
    readonly blocked: string;
}

// The path contains /vera-dev/ so the CLI takes its no-host path.
async function fixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "wb5-block-"));
    const home = join(root, "vera-dev", "home");
    const sessions = join(veraRuntimeDirectoryIn(home), "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${SESSION_ID}.jsonl`), "");
    return { root, home, blocked: veraBlockedDirectoryIn(home) };
}

function env(home: string): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("VERA_")) base[key] = value;
    }
    return { ...base, VERA_HOME: home, VERA_DEV_INSTANCE: "wb5gaps dev" };
}

interface PtyRun {
    readonly exitCode: number;
    readonly output: string;
}

// Spawns the CLI on a pseudo-terminal, waits for the prompt, then sends `answer`.
async function runOnTerminal(
    home: string,
    args: readonly string[],
    answer: string,
): Promise<PtyRun> {
    let output = "";
    let prompted = false;
    let resolvePrompt: () => void = () => {};
    const promptSeen = new Promise<void>((resolve) => {
        resolvePrompt = resolve;
    });
    const proc = Bun.spawn(["bun", CLI, ...args], {
        cwd: join(import.meta.dir, ".."),
        env: env(home),
        terminal: {
            cols: 120,
            rows: 40,
            data(_terminal, chunk) {
                output += new TextDecoder().decode(chunk);
                if (!prompted && output.includes("[y/N]")) {
                    prompted = true;
                    resolvePrompt();
                }
            },
        },
    });
    const timeout = setTimeout(() => resolvePrompt(), 15_000);
    await promptSeen;
    clearTimeout(timeout);
    proc.terminal?.write(`${answer}\r`);
    const exitCode = await proc.exited;
    proc.terminal?.close();
    return { exitCode, output };
}

test("block on a terminal: answering no writes no flag and exits 1", async () => {
    const run = await fixture();
    try {
        const result = await runOnTerminal(run.home, ["block", SESSION_ID], "n");
        expect(result.output).toContain(`Block 1 session? [y/N]`);
        expect(result.output).toContain("Not blocked.");
        expect(result.exitCode).toBe(1);
        expect(isSessionBlockedSync(run.blocked, SESSION_ID)).toBe(false);
    } finally {
        await rm(run.root, { recursive: true, force: true });
    }
});

test("block on a terminal: answering yes writes the flag and exits 0", async () => {
    const run = await fixture();
    try {
        const result = await runOnTerminal(run.home, ["block", SESSION_ID, "--reason", "pty check"], "y");
        expect(result.output).toContain("Reason: pty check.");
        expect(result.output).toContain(`Blocked ${SESSION_ID}.`);
        expect(result.exitCode).toBe(0);
        expect(isSessionBlockedSync(run.blocked, SESSION_ID)).toBe(true);
    } finally {
        await rm(run.root, { recursive: true, force: true });
    }
});

test("block without a terminal refuses, prints nothing to confirm, and writes no flag", async () => {
    const run = await fixture();
    try {
        const proc = Bun.spawn(["bun", CLI, "block", SESSION_ID], {
            cwd: join(import.meta.dir, ".."),
            env: env(run.home),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect(stderr).toContain("vera block needs a terminal to confirm.");
        expect(stdout).not.toContain("[y/N]");
        expect(exitCode).toBe(1);
        expect(isSessionBlockedSync(run.blocked, SESSION_ID)).toBe(false);
    } finally {
        await rm(run.root, { recursive: true, force: true });
    }
});

test("block has no --yes; a non-terminal caller gets the usage error", async () => {
    const run = await fixture();
    try {
        const proc = Bun.spawn(["bun", CLI, "block", SESSION_ID, "--yes"], {
            cwd: join(import.meta.dir, ".."),
            env: env(run.home),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect(stderr).toContain("block needs the id of a live agent or session.");
        expect(exitCode).toBe(1);
        expect(isSessionBlockedSync(run.blocked, SESSION_ID)).toBe(false);
    } finally {
        await rm(run.root, { recursive: true, force: true });
    }
});
