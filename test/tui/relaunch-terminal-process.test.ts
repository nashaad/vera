import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forceStopResidentHost } from "../../src/host/force-stop.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { releaseSourceEntries, writeExternalWrappers } from "../../src/release/wrappers.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

const terminalRestore = join(import.meta.dir, "../../clients/tui/terminal-restore.ts");

function modesLeftOn(output: string, modes: readonly number[]): number[] {
    const state = new Map<number, boolean>();
    for (const match of output.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
        for (const part of match[1]!.split(";")) {
            const mode = Number(part);
            if (modes.includes(mode)) state.set(mode, match[2] === "h");
        }
    }
    return modes.filter((mode) => state.get(mode) === true);
}

test("@core a relaunch relinquishes its input modes without leaving the alternate screen", async () => {
    const source = `
        import { writeSync } from "node:fs";
        import * as terminal from ${JSON.stringify(terminalRestore)};
        writeSync(1, "\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h\\x1b[?2004h\\x1b[>1u");
        terminal.installTerminalRestoreOnExit({ fd: 1, isTTY: true });
        terminal.markKittyKeyboardEnabled?.();
        terminal.markTerminalRestored("relaunch");
        process.exit(85);
    `;
    const child = Bun.spawn([process.execPath, "-e", source], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [output, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 85, stderr: "" });
    expect(output).toContain("\x1b[?1049h");
    expect(output).not.toContain("\x1b[?1049l");
    for (const mode of [1000, 1002, 1003, 1006, 2004]) {
        expect(output.lastIndexOf(`\x1b[?${mode}l`)).toBeGreaterThan(output.lastIndexOf(`\x1b[?${mode}h`));
    }
    expect(output.match(/\x1b\[>\d*u/g)?.length).toBe(1);
    expect(output.match(/\x1b\[<u/g)?.length).toBe(1);
    expect(output).toContain("\x1b[?25h");
}, 10_000);

test("@core an early successor restores the screen without popping an unpushed keyboard mode", async () => {
    const source = `
        import { writeSync } from "node:fs";
        import { installTerminalRestoreOnExit } from ${JSON.stringify(terminalRestore)};
        writeSync(1, "\\x1b[?1049h");
        installTerminalRestoreOnExit({ fd: 1, isTTY: true });
        process.exit(42);
    `;
    const child = Bun.spawn([process.execPath, "-e", source], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [output, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 42, stderr: "" });
    expect(output.match(/\x1b\[\?1049l/g)?.length).toBe(1);
    expect(output).not.toContain("\x1b[<u");
}, 10_000);

test("@core a relaunch handoff turns off focus reporting and colour-scheme reports", async () => {
    const source = `
        import { writeSync } from "node:fs";
        import * as terminal from ${JSON.stringify(terminalRestore)};
        writeSync(1, "\\x1b[?1049h\\x1b[?1004h\\x1b[?2031h");
        terminal.installTerminalRestoreOnExit({ fd: 1, isTTY: true });
        terminal.markTerminalRestored("relaunch");
        process.exit(85);
    `;
    const child = Bun.spawn([process.execPath, "-e", source], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [output, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ status, stderr }).toEqual({ status: 85, stderr: "" });
    expect(output).not.toContain("\x1b[?1049l");
    expect(modesLeftOn(output, [1004, 2031])).toEqual([]);
}, 10_000);

interface LiveRecord {
    readonly kind: string;
    readonly pid: number;
}

type Successor = "success" | "early" | "late";

const realProcessTest = process.platform === "win32"
    || spawnSync("tmux", ["-V"]).status !== 0
    ? test.skip : socketAndLoopbackTest;

function quote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function until(check: () => boolean, label: string, timeoutMs = 25_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(50);
    }
}

function assertTerminalRestored(output: string, successor: Successor): void {
    expect(output.match(/\x1b\[\?1049l/g)?.length ?? 0).toBe(1);
    expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.lastIndexOf("\x1b[?25l"));
    for (const mode of [1000, 1002, 1003, 1006, 2004]) {
        expect(output.lastIndexOf(`\x1b[?${mode}l`)).toBeGreaterThan(output.lastIndexOf(`\x1b[?${mode}h`));
    }
    expect(modesLeftOn(output, [1004, 2031])).toEqual([]);
    const expected = successor === "success" ? 2 : 1;
    expect(output.match(/\x1b\[>\d*u/g)?.length ?? 0).toBe(expected);
    expect(output.match(/\x1b\[<u/g)?.length ?? 0).toBe(expected);
}

async function captureRelaunch(successor: Successor): Promise<void> {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "vera-dev", "relaunch-terminal-"));
    const home = join(root, "vera");
    const userHome = join(root, "user");
    const share = join(userHome, ".local", "share", "vera");
    const oldRelease = join(share, "releases", "terminal-old");
    const nextRelease = join(share, "releases", "terminal-next");
    const current = join(share, "current");
    const raw = join(root, "terminal.raw");
    const live = join(home, "machine", "live");
    const socket = join(root, "tmux.sock");
    const gate = Promise.withResolvers<void>();
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
                return Response.json({ data: [{ id: "stub-model" }] });
            }
            requests += 1;
            await gate.promise;
            return new Response('data: {"id":"stub","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, TMPDIR: root, VERA_HOME: home,
        TERM: "xterm-256color", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "localhost,127.0.0.1,::1",
    };
    const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], {
        cwd: process.cwd(), env, encoding: "utf8",
    });
    const pane = () => tmux("capture-pane", "-p", "-t", "terminal").stdout;
    const dead = () => tmux("display-message", "-p", "-t", "terminal", "#{pane_dead}").stdout.trim() === "1";
    const send = (...keys: string[]) => tmux("send-keys", "-t", "terminal", ...keys);
    const liveRecords = (): LiveRecord[] => existsSync(live)
        ? readdirSync(live).filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(live, name), "utf8")) as LiveRecord)
        : [];
    let stopCommand: ReturnType<typeof Bun.spawn> | undefined;
    let started = false;
    let passed = false;
    const tracked = new Set<number>();
    try {
        if (stub.port === undefined || stub.port === 8372) throw new Error("Invalid stub port");
        for (const [dir, build] of [[oldRelease, "terminal-old"], [nextRelease, "terminal-next"]] as const) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "manifest.json"), JSON.stringify({
                layout_version: 1, product_version: "0.1.0-test", source_revision: "test", build_id: build,
                protocol_version: 1, relaunch_record_version: 1, platform: process.platform, arch: process.arch,
                asset_digest: "sha256:test", built_at: "2026-01-01T00:00:00.000Z",
                artifacts: ["cli", "tui", "host", "worker", "annex", "annex_assets", "builtins"],
            }));
            writeExternalWrappers(dir, process.execPath, releaseSourceEntries(process.cwd()));
        }
        if (successor !== "success") {
            const shim = join(root, "launcher-bun");
            const marker = join(root, "first-launch");
            const lateEntry = join(root, "late.ts");
            writeFileSync(lateEntry, `import { installTerminalRestoreOnExit } from ${JSON.stringify(terminalRestore)};\ninstallTerminalRestoreOnExit();\nprocess.exit(42);\n`);
            const failure = successor === "late"
                ? `exec ${quote(process.execPath)} ${quote(lateEntry)}` : "exit 42";
            writeFileSync(shim, `#!/bin/sh\ncase " $* " in *' --vera-restore-relaunch-terminal '*) exec ${quote(process.execPath)} "$@";; esac\nif [ -e ${quote(marker)} ]; then ${failure}; fi\ntouch ${quote(marker)}\nexec ${quote(process.execPath)} "$@"\n`);
            chmodSync(shim, 0o755);
            const launcher = join(oldRelease, "vera");
            writeFileSync(launcher, readFileSync(launcher, "utf8").replaceAll(quote(process.execPath), quote(shim)));
        }
        symlinkSync("releases/terminal-old", current);
        mkdirSync(join(home, "machine"), { recursive: true });
        writeFileSync(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            host: { workers: 0 },
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        }));
        writeFileSync(join(home, "machine", "env"), `PATH=${env.PATH}\n`);
        const launch = `sleep 1; ${quote(join(oldRelease, "vera"))} --bare; code=$?; printf 'LAUNCHER_DONE:%s\\n' "$code"`;
        const start = tmux("-f", "/dev/null", "new-session", "-d", "-s", "terminal", "-x", "120", "-y", "40", "-c", process.cwd(), launch);
        if (start.status !== 0) throw new Error(start.stderr);
        started = true;
        tmux("set-option", "-t", "terminal", "remain-on-exit", "on");
        const pipe = tmux("pipe-pane", "-O", "-t", "terminal", `cat > ${quote(raw)}`);
        if (pipe.status !== 0) throw new Error(pipe.stderr);
        await until(() => pane().includes("Start a conversation with Vera") || pane().includes("or just start typing"), "initial TUI", 40_000);
        await until(() => liveRecords().some((record) => record.kind === "tui"), "initial TUI record");
        const initialPid = liveRecords().find((record) => record.kind === "tui")!.pid;
        send("-l", "Chart a slow course"); send("Enter");
        await until(() => requests > 0, "running turn");
        for (const record of liveRecords()) tracked.add(record.pid);
        stopCommand = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", "--yes"], {
            cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
        });
        await until(() => pane().includes("Vera is shutting down") || pane().includes("Vera stops when running turns finish"), "stop card");
        send("Down"); send("Enter");
        await until(() => pane().includes("host stopped · Ctrl+L restart"), "stopped host");
        expect(await stopCommand.exited).toBe(0);
        unlinkSync(current); symlinkSync("releases/terminal-next", current);
        send("C-l");
        if (successor === "success") {
            await until(() => liveRecords().some((record) => record.kind === "tui" && record.pid !== initialPid), "successor TUI", 45_000);
            await until(() => pane().includes("    ready ") || pane().includes("Start a conversation with Vera") || pane().includes("or just start typing"), "successor ready", 45_000);
            for (const record of liveRecords()) tracked.add(record.pid);
            send("C-c"); await Bun.sleep(350); send("C-c");
        }
        await until(dead, "launcher exit", 45_000);
        await Bun.sleep(250);
        const output = readFileSync(raw, "utf8");
        expect(output).toContain(`LAUNCHER_DONE:${successor === "success" ? 0 : 42}`);
        assertTerminalRestored(output, successor);
        const records = join(home, "runtime", "relaunch");
        expect(existsSync(records) ? readdirSync(records) : []).toEqual([]);
        passed = true;
    } catch (error) {
        throw new Error(`Relaunch capture failed; output retained at ${root}\n${pane()}`, { cause: error });
    } finally {
        gate.resolve();
        if (started) tmux("kill-server");
        try {
            await forceStopResidentHost({
                home, lockPath: join(home, "runtime", "host.json"),
                kill: (pid, signal) => {
                    console.log(`relaunch test cleanup: ${signal} to ${pid}`);
                    process.kill(pid, signal);
                },
            });
        } catch {}
        stub.stop(true);
        if (stopCommand && stopCommand.exitCode === null) await stopCommand.exited;
        await until(() => [...tracked].every((pid) => !processIsAlive(pid)), "trial process cleanup", 10_000);
        if (passed) rmSync(root, { recursive: true, force: true });
    }
}

realProcessTest("@core a real relaunch balances kitty and exits the alternate screen once", async () => {
    await captureRelaunch("success");
}, 90_000);

realProcessTest("@core an early successor failure restores once without an extra kitty pop", async () => {
    await captureRelaunch("early");
}, 90_000);

realProcessTest("@core a successor exit after installing its handler restores only once", async () => {
    await captureRelaunch("late");
}, 90_000);
