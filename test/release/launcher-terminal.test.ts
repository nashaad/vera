import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TERMINAL_RESTORE_SEQUENCE } from "../../src/terminal-restore-sequence.ts";
import { writeExternalWrappers } from "../../src/release/wrappers.ts";

const homes: string[] = [];
afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function runLauncher(mode: "killed" | "handled" | "normal"): Promise<{ status: number; restored: boolean; output: string }> {
    const root = join(tmpdir(), "vera-dev");
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, "launcher-terminal-"));
    homes.push(home);
    const entrypoint = join(home, "child.ts");
    const marker = join(home, "child.pid");
    writeFileSync(entrypoint, `
        import { writeFileSync } from "node:fs";
        const saved = Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
        Bun.spawnSync(["stty", "raw", "-echo"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
        process.stdout.write("\\x1b[?1049h");
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
