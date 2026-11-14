#!/usr/bin/env bun

// Builds the desktop app once, then runs each clients/desktop/test/*.e2e.mjs in turn.
// Trial homes are created under a scratch folder that this runner sets as TMPDIR,
// so a host left behind by a killed script is found there and stopped by its recorded pid.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "clients", "desktop");
const testDir = join(desktop, "test");
const SCRIPT_TIMEOUT_MS = 300_000;
const STOP_GRACE_MS = 5_000;

interface Outcome {
    readonly name: string;
    readonly passed: boolean;
    readonly seconds: number;
    readonly timedOut: boolean;
    readonly output: string;
}

const filter = (process.argv[2] ?? "").toLowerCase();
const scripts = readdirSync(testDir)
    .filter((name) => name.endsWith(".e2e.mjs"))
    .filter((name) => name.toLowerCase().includes(filter))
    .sort();

if (scripts.length === 0) {
    console.error(filter ? `No desktop e2e script matches "${filter}".` : "No desktop e2e scripts found.");
    process.exit(1);
}

const build = spawnSync("bun", ["run", "build"], { cwd: desktop, stdio: "inherit" });
if (build.status !== 0) {
    console.error("Desktop build failed; no e2e script was run.");
    process.exit(build.status ?? 1);
}

// The browser script needs the annex page; a built one is left as it is.
if (!existsSync(join(root, "dist", "release", "annex", "index.html"))) {
    const pack = spawnSync("bun", ["run", "pack:web"], { cwd: root, stdio: "inherit" });
    if (pack.status !== 0) {
        console.error("Annex build failed; no e2e script was run.");
        process.exit(pack.status ?? 1);
    }
}

// A macOS socket path is limited to 85 characters, so the default temp folder is too long to nest trial homes in.
const scratch = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "vera-desktop-run-"));
const logDir = mkdtempSync(join(tmpdir(), "vera-desktop-logs-"));
const outcomes: Outcome[] = [];

for (const name of scripts) {
    const outcome = await runScript(name);
    outcomes.push(outcome);
    const status = outcome.passed ? "PASS" : "FAIL";
    const note = outcome.timedOut ? "  (timed out)" : "";
    const forced = outcome.output.includes("forced close after") ? "  (forced close)" : "";
    console.log(`${status}  ${name}  ${outcome.seconds.toFixed(1)}s${note}${forced}`);
    if (!outcome.passed) {
        const logPath = join(logDir, `${name}.log`);
        writeFileSync(logPath, outcome.output);
        console.log(`      log: ${logPath}`);
        console.log(`      first error: ${firstError(outcome.output)}`);
    }
    await stopHostsIn(scratch);
}

const failed = outcomes.filter((outcome) => !outcome.passed).length;
const passed = outcomes.length - failed;
console.log(`\n${passed} passed, ${failed} failed, ${outcomes.length} total.`);

rmSync(scratch, { recursive: true, force: true });
if (failed === 0) rmSync(logDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);

function runScript(name: string): Promise<Outcome> {
    const started = Date.now();
    return new Promise((resolve) => {
        const child = spawn("node", [join(testDir, name)], {
            cwd: root,
            detached: true,
            env: { ...process.env, TMPDIR: scratch },
        });
        let output = "";
        let timedOut = false;
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

        const timer = setTimeout(() => {
            timedOut = true;
            signalGroup(child.pid, "SIGTERM");
            setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
        }, SCRIPT_TIMEOUT_MS);

        child.on("close", (code) => {
            clearTimeout(timer);
            signalGroup(child.pid, "SIGTERM");
            resolve({
                name,
                passed: !timedOut && code === 0,
                seconds: (Date.now() - started) / 1000,
                timedOut,
                output,
            });
        });
    });
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) return;
    try {
        process.kill(-pid, signal);
    } catch {
        // The group has already exited.
    }
}

function firstError(output: string): string {
    const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const match = lines.find((line) => /error|timeout|exceeded|assert|expected/i.test(line)
        && !/^\w+: /.test(line) && !/^at /.test(line));
    return match ?? lines[0] ?? "no output";
}

// Stops only hosts whose recorded socket lives under their own trial home.
async function stopHostsIn(scratchRoot: string): Promise<void> {
    for (const entry of readdirSync(scratchRoot)) {
        if (!entry.startsWith("vera-desktop-e2e-")) continue;
        const home = join(scratchRoot, entry, ".vera");
        const recordPath = join(home, "runtime", "host.json");
        if (!existsSync(recordPath)) continue;
        const pid = ownedPid(recordPath, home);
        if (pid === undefined) continue;
        await stopPid(pid);
    }
}

function ownedPid(recordPath: string, home: string): number | undefined {
    try {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        const owned = typeof record.pid === "number" && record.pid > 0
            && typeof record.socket_path === "string" && record.socket_path.startsWith(home);
        if (!owned) return undefined;
        process.kill(record.pid, 0);
        return record.pid;
    } catch {
        return undefined;
    }
}

async function stopPid(pid: number): Promise<void> {
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
    }
    process.kill(pid, "SIGKILL");
}
