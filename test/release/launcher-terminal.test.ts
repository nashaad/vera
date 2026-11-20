import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TERMINAL_INPUT_RESTORE_SEQUENCE, TERMINAL_RESTORE_SEQUENCE, TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE } from "../../src/terminal-restore-sequence.ts";
import { writeExternalWrappers } from "../../src/release/wrappers.ts";

const homes: string[] = [];
afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function runLauncher(mode: "killed" | "handled" | "normal" | "relaunch-killed"): Promise<{ status: number; restored: boolean; output: string }> {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, "launcher-terminal-"));
    homes.push(home);
    const entrypoint = join(home, "child.ts");
    const marker = join(home, "child.pid");
    const firstLaunch = join(home, "first-launch");
    writeFileSync(entrypoint, `
        import { existsSync, writeFileSync, writeSync } from "node:fs";
        import { launcherKeyFromEnv, takeRelaunchRecord, writeRelaunchRecord } from ${JSON.stringify(join(import.meta.dir, "../../src/release/relaunch.ts"))};
        import { restoreUnclaimedRelaunchTerminal } from ${JSON.stringify(join(import.meta.dir, "../../src/release/relaunch-terminal.ts"))};
        if (process.argv[2] === "--vera-restore-relaunch-terminal") {
            writeSync(1, "RELAUNCH_HELPER_CALLED");
            restoreUnclaimedRelaunchTerminal(process.argv[3]);
            process.exit(0);
        }
        const saved = Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
        Bun.spawnSync(["stty", "raw", "-echo"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
        writeSync(1, "\\x1b[?1049h");
        if (process.env.TEST_LAUNCH_MODE === "relaunch-killed") {
            const key = launcherKeyFromEnv();
            if (key === undefined) process.exit(1);
            const inputModesOn = "\\x1b[?25l\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h\\x1b[?2004h\\x1b[>1u";
            if (!existsSync(${JSON.stringify(firstLaunch)})) {
                writeRelaunchRecord(key, { sessionId: "terminal-test", writtenAt: new Date().toISOString() });
                writeFileSync(${JSON.stringify(firstLaunch)}, "");
                writeSync(1, inputModesOn + ${JSON.stringify(TERMINAL_INPUT_RESTORE_SEQUENCE)});
                process.exit(85);
            }
            if (takeRelaunchRecord(key)?.sessionId !== "terminal-test") process.exit(2);
            writeSync(1, inputModesOn + "RELAUNCH_RECORD_TAKEN");
            writeFileSync(${JSON.stringify(marker)}, String(process.pid));
            process.kill(process.pid, "SIGKILL");
        }
        if (process.env.TEST_LAUNCH_MODE === "handled") {
            process.on("SIGTERM", () => {
                Bun.spawnSync(["stty", saved], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
                process.stdout.write(${JSON.stringify(TERMINAL_RESTORE_SEQUENCE)});
                process.exit(143);
            });
        }
        writeFileSync(${JSON.stringify(marker)}, String(process.pid));
        if (process.env.TEST_LAUNCH_MODE === "normal") {
            Bun.spawnSync(["stty", saved], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
            process.exit(0);
        }
        setInterval(() => {}, 1000);
    `);
    writeExternalWrappers(home, process.execPath, {
        cli: entrypoint, host: entrypoint, worker: entrypoint,
        sessionWorker: entrypoint, annex: entrypoint, supervisor: entrypoint,
    });
    const launcher = join(home, "vera");
    const python = `
import base64, json, os, pty, select, signal, subprocess, sys, termios, time
launcher, marker, mode = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
env = dict(os.environ, TEST_LAUNCH_MODE=mode)
p = subprocess.Popen([launcher, mode], stdin=slave, stdout=slave, stderr=slave, env=env)
child = None
try:
    deadline = time.monotonic() + 8
    while not os.path.exists(marker) and p.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    if not os.path.exists(marker):
        raise RuntimeError("child did not become ready")
    with open(marker) as f:
        child = int(f.read())
    if mode == "killed":
        os.kill(child, signal.SIGKILL)
    elif mode == "handled":
        os.kill(child, signal.SIGTERM)
    status = p.wait(timeout=8)
    after = termios.tcgetattr(slave)
    # macOS stty can set the transient pending-input flag during restoration.
    before[3] &= ~termios.PENDIN
    after[3] &= ~termios.PENDIN
    chunks = []
    while select.select([master], [], [], 0.1)[0]:
        chunks.append(os.read(master, 65536))
    print(json.dumps({"status": status, "restored": before == after,
                      "output": base64.b64encode(b"".join(chunks)).decode()}))
finally:
    if p.poll() is None:
        if child is not None:
            try: os.kill(child, signal.SIGKILL)
            except ProcessLookupError: pass
        p.kill()
        p.wait()
    os.close(master)
    os.close(slave)
`;
    const subprocess = Bun.spawn(["python3", "-c", python, launcher, marker, mode], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...globalThis.process.env, VERA_HOME: home },
    });
    const [stdout, stderr, status] = await Promise.all([
        new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const result = JSON.parse(stdout) as { status: number; restored: boolean; output: string };
    return { ...result, output: Buffer.from(result.output, "base64").toString("utf8") };
}

test("@core launcher restores the saved tty and terminal once after SIGKILL", async () => {
    const result = await runLauncher("killed");
    expect(result.status).toBe(137);
    expect(result.restored).toBe(true);
    expect(result.output.split(TERMINAL_RESTORE_SEQUENCE).length - 1).toBe(1);
}, 20_000);

test("@core launcher restores fully when the successor is killed after a relaunch", async () => {
    const result = await runLauncher("relaunch-killed");
    expect(result.status).toBe(137);
    expect(result.restored).toBe(true);
    expect(result.output).toContain("RELAUNCH_RECORD_TAKEN");
    expect(result.output.split(TERMINAL_RESTORE_SEQUENCE).length - 1).toBe(1);
    expect(result.output.match(/\x1b\[\?1049l/g)?.length ?? 0).toBe(1);
    expect(result.output.match(/\x1b\[>\d*u/g)?.length ?? 0).toBe(2);
    expect(result.output.match(/\x1b\[<u/g)?.length ?? 0).toBe(2);
    expect(result.output).not.toContain("RELAUNCH_HELPER_CALLED");
    for (const mode of [1000, 1002, 1003, 1006, 2004]) {
        expect(result.output.lastIndexOf(`\x1b[?${mode}l`)).toBeGreaterThan(result.output.lastIndexOf(`\x1b[?${mode}h`));
    }
    expect(result.output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(result.output.lastIndexOf("\x1b[?25l"));
}, 20_000);

test("launcher does not repeat restoration after a handled termination", async () => {
    const result = await runLauncher("handled");
    expect(result.status).toBe(143);
    expect(result.restored).toBe(true);
    expect(result.output.split(TERMINAL_RESTORE_SEQUENCE).length - 1).toBe(1);
}, 20_000);

test("launcher leaves terminal restoration to a normally exiting child", async () => {
    const result = await runLauncher("normal");
    expect(result.status).toBe(0);
    expect(result.restored).toBe(true);
    expect(result.output).not.toContain(TERMINAL_RESTORE_SEQUENCE);
}, 20_000);

test("@core a missing relaunch helper restores without another kitty pop", async () => {
    for (const helperStatus of [126, 127]) {
        const root = join(tmpdir(), "vera-dev");
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, "launcher-fallback-"));
        homes.push(home);
        const entrypoint = join(home, "child.ts");
        const marker = join(home, "first");
        writeFileSync(entrypoint, `
            import { existsSync, writeFileSync } from "node:fs";
            if (process.argv.includes("--vera-restore-relaunch-terminal")) process.exit(${helperStatus});
            if (existsSync(${JSON.stringify(marker)})) process.exit(42);
            writeFileSync(${JSON.stringify(marker)}, "");
            process.stdout.write("\\x1b[?1049h\\x1b[>1u\\x1b[<u");
            process.exit(85);
        `);
        writeExternalWrappers(home, process.execPath, {
            cli: entrypoint, host: entrypoint, worker: entrypoint,
            sessionWorker: entrypoint, annex: entrypoint, supervisor: entrypoint,
        });
        const python = `
import base64, json, os, pty, select, subprocess, sys
master, slave = pty.openpty()
p = subprocess.Popen([sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, env=os.environ)
try:
    status = p.wait(timeout=8)
    chunks = []
    while select.select([master], [], [], 0.1)[0]:
        chunks.append(os.read(master, 65536))
    print(json.dumps({"status": status, "output": base64.b64encode(b"".join(chunks)).decode()}))
finally:
    if p.poll() is None:
        p.kill()
        p.wait()
    os.close(master)
    os.close(slave)
`;
        const child = Bun.spawn(["python3", "-c", python, join(home, "vera")], {
            stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, VERA_HOME: home },
        });
        const [stdout, stderr, status] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
        const result = JSON.parse(stdout) as { status: number; output: string };
        const output = Buffer.from(result.output, "base64").toString("utf8");
        expect(result.status).toBe(42);
        expect(output).toContain(TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE);
        expect(output.match(/\x1b\[\?1049l/g)?.length ?? 0).toBe(1);
        expect(output.match(/\x1b\[>\d*u/g)?.length ?? 0).toBe(1);
        expect(output.match(/\x1b\[<u/g)?.length ?? 0).toBe(1);
    }
}, 20_000);
