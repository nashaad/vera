import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { forceStopResidentHost } from "../../src/host/force-stop.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";

interface LiveRecord {
    readonly kind: string;
    readonly pid: number;
}

async function until(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(25);
    }
}

const realProcessTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    || process.platform === "win32"
    || spawnSync("tmux", ["-V"]).status !== 0
    ? test.skip : test;

realProcessTest("a TUI that exits after a busy host stop removes its live record", async () => {
    const root = mkdtempSync("/private/tmp/vera-dev/tui-clean-stop-");
    const home = join(root, "vera");
    const socket = join(root, "tmux.sock");
    const live = join(home, "machine", "live");
    mkdirSync(home, { recursive: true });
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
    if (stub.port === undefined || stub.port === 8372) {
        stub.stop(true);
        rmSync(root, { recursive: true, force: true });
        throw new Error("Invalid stub port");
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    }));
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root, VERA_HOME: home,
        VERA_DEV_INSTANCE: "stopfix dev", TERM: "xterm-256color",
        HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1,::1",
    };
    const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], {
        cwd: process.cwd(), env, encoding: "utf8",
    });
    const pane = () => tmux("capture-pane", "-p", "-t", "stoptrial").stdout;
    const liveRecords = (): LiveRecord[] => {
        if (!existsSync(live)) return [];
        return readdirSync(live).filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(live, name), "utf8")) as LiveRecord);
    };
    let tuiPid: number | undefined;
    let tracked: number[] = [];
    try {
        const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "stoptrial", "-x", "120", "-y", "40",
            "-c", process.cwd(), "bun clients/cli/main.ts --bare");
        if (started.status !== 0) throw new Error(started.stderr);
        tmux("set-option", "-t", "stoptrial", "remain-on-exit", "on");
        await until(() => pane().includes("Start a conversation with Vera"), "TUI startup");
        await until(() => liveRecords().some((record) => record.kind === "tui"), "TUI live record");
        tuiPid = liveRecords().find((record) => record.kind === "tui")!.pid;
        tmux("send-keys", "-t", "stoptrial", "-l", "Chart a course");
        tmux("send-keys", "-t", "stoptrial", "Enter");
        await until(() => requests > 0, "model request");
        tracked = liveRecords().map((record) => record.pid);
        const command = Bun.spawn([process.execPath, "clients/cli/main.ts", "host", "stop", "--yes"], {
            cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
        });
        const result = Promise.all([command.exited, new Response(command.stdout).text(), new Response(command.stderr).text()]);
        await until(() => pane().includes("Vera is stopping."), "stop dialog");
        gate.resolve();
        const [exitCode, , stderr] = await result;
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        await until(() => pane().includes("host stopped · Ctrl+L restart"), "host stopped footer");
        tmux("send-keys", "-t", "stoptrial", "C-c");
        await Bun.sleep(300);
        tmux("send-keys", "-t", "stoptrial", "C-c");
        await until(() => tmux("display-message", "-p", "-t", "stoptrial", "#{pane_dead}").stdout.trim() === "1", "TUI exit");
        expect(tmux("display-message", "-p", "-t", "stoptrial", "#{pane_dead_status}").stdout.trim()).toBe("0");
        await until(() => !processIsAlive(tuiPid!), "TUI process exit");
        expect(existsSync(join(live, `${tuiPid}.json`))).toBe(false);
        await until(() => liveRecords().length === 0, "live record cleanup");
        expect(liveRecords()).toEqual([]);
    } finally {
        gate.resolve();
        tmux("kill-server");
        try { await forceStopResidentHost({ home, lockPath: join(home, "runtime", "host.json") }); } catch {}
        stub.stop(true);
        await until(() => tracked.every((pid) => !processIsAlive(pid)), "trial process cleanup", 10_000);
        rmSync(root, { recursive: true, force: true });
    }
}, 45_000);
