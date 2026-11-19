import { expect, test } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { sourceTestHome } from "../support/source-test-home.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

interface HostLock {
    readonly pid: number;
}

interface StubMessage {
    readonly role?: string;
    readonly content?: unknown;
}

interface StubRequest {
    readonly messages?: readonly StubMessage[];
}

function isAlive(pid: number): boolean {
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return status.length > 0 && !status.startsWith("Z");
}

function readHostPid(trialHome: string): number | undefined {
    try {
        return (JSON.parse(readFileSync(join(trialHome, "runtime/host.json"), "utf8")) as HostLock).pid;
    } catch {
        return undefined;
    }
}

function verifiedHost(pid: number, trialHome: string): boolean {
    const command = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout;
    return command.includes(`VERA_HOME=${trialHome}`) && command.includes("vera-host");
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!await check()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(25);
    }
}

const realProcessTest = process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0
    ? test.skip
    : socketAndLoopbackTest;

realProcessTest("Reconnect host inside a busy conversation keeps its host and tool running", async () => {
    const tempBase = join(tmpdir(), "vera-dev");
    mkdirSync(tempBase, { recursive: true });
    const root = mkdtempSync(join(tempBase, "hostbusy-reconnect-"));
    const trialHome = join(root, "h");
    const socket = join(root, "tmux.sock");
    const toolPidPath = join(root, "tool.pid");
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: sourceTestHome(root),
        VERA_HOME: trialHome,
        VERA_DEV_INSTANCE: `${basename(process.cwd())} dev`,
        TMPDIR: root,
        TERM: "xterm-256color",
    };
    mkdirSync(trialHome, { recursive: true });
    const command = `echo $$ > '${toolPidPath}'; exec sleep 45`;
    const providerReply = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            if (request.method === "GET") return Response.json({ data: [{ id: "stub-model" }] });
            const body = await request.json() as StubRequest;
            const classifier = body.messages?.[0]?.role === "system"
                && typeof body.messages[0].content === "string"
                && body.messages[0].content.startsWith("You review one proposed action");
            const hasResult = body.messages?.some((message) => message.role === "tool") === true;
            if (hasResult) await providerReply.promise;
            const delta = classifier
                ? { role: "assistant", content: '{"outcome":"allow"}' }
                : hasResult
                ? { role: "assistant", content: "The crow returns." }
                : {
                    role: "assistant",
                    tool_calls: [{
                        index: 0,
                        id: "call-sleep",
                        type: "function",
                        function: { name: "bash", arguments: JSON.stringify({ command }) },
                    }],
                };
            const chunk = {
                id: "stub",
                object: "chat.completion.chunk",
                model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: classifier || hasResult ? "stop" : "tool_calls" }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
    if (stub.port === undefined || stub.port === 8372) {
        stub.stop(true);
        rmSync(root, { recursive: true, force: true });
        throw new Error("Invalid stub port");
    }
    writeFileSync(join(trialHome, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "stub",
        model: "stub-model",
        approval_mode: "auto",
        host: { workers: 0 },
        providers: {
            stub: {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${stub.port}/v1`,
                credential: "none",
            },
        },
    }));
    const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
    });
    const pane = (): string => tmux("capture-pane", "-p", "-t", "hostbusy").stdout;
    const normalizedPane = (): string => pane().replace(/\s+/g, " ").trim();
    let hostPid: number | undefined;
    let toolPid: number | undefined;
    try {
        const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "hostbusy", "-x", "120", "-y", "40",
            "-c", process.cwd(), "bun clients/cli/main.ts");
        if (started.status !== 0) throw new Error(started.stderr);
        await waitUntil(() => pane().includes("or just start typing"), "home");
        tmux("send-keys", "-t", "hostbusy", "-l", "A crow starts a slow voyage");
        tmux("send-keys", "-t", "hostbusy", "Enter");
        await waitUntil(() => pane().includes("running bash") && existsSync(toolPidPath), "running bash");
        toolPid = Number(readFileSync(toolPidPath, "utf8").trim());
        hostPid = readHostPid(trialHome);
        if (hostPid === undefined || !verifiedHost(hostPid, trialHome)) {
            throw new Error("Could not verify the private trial host");
        }
        expect(Number.isSafeInteger(toolPid) && toolPid > 0 && isAlive(toolPid)).toBe(true);

        tmux("send-keys", "-t", "hostbusy", "C-p");
        await waitUntil(() => pane().includes("Commands"), "command palette");
        tmux("send-keys", "-t", "hostbusy", "-l", "reconnect host");
        await waitUntil(() => pane().includes("Reconnect host"), "Reconnect host action");
        tmux("send-keys", "-t", "hostbusy", "Enter");
        const busyMessage = "Could not restart the host: other work is still using it. "
            + "This session is still connected. Choose Reconnect host again once that work finishes.";
        try {
            await waitUntil(() => normalizedPane().includes(busyMessage), "busy reconnect message");
        } catch (error) {
            throw new Error(`${String(error)}\n${pane()}`);
        }

        expect(normalizedPane()).toContain(busyMessage);
        expect(readHostPid(trialHome)).toBe(hostPid);
        expect(verifiedHost(hostPid, trialHome)).toBe(true);
        expect(isAlive(toolPid)).toBe(true);
        expect(spawnSync("ps", ["-o", "command=", "-p", String(toolPid)], { encoding: "utf8" }).stdout.trim())
            .toBe("sleep 45");
        expect(pane()).not.toContain("Host stopped unexpectedly");
        expect(pane()).not.toContain("Start a conversation with Vera.");
        expect(pane()).not.toContain("The running Vera host is not responding properly");
    } finally {
        providerReply.resolve();
        tmux("kill-server");
        const hosts = new Set([hostPid, readHostPid(trialHome)]);
        for (const pid of hosts) {
            if (pid === undefined || !isAlive(pid)) continue;
            if (!verifiedHost(pid, trialHome)) throw new Error("Refusing to signal an unverified host process");
            process.kill(pid, "SIGTERM");
            await waitUntil(() => !isAlive(pid), "private trial host exit", 10_000);
        }
        if (toolPid === undefined && existsSync(toolPidPath)) toolPid = Number(readFileSync(toolPidPath, "utf8").trim());
        if (toolPid !== undefined && Number.isSafeInteger(toolPid) && toolPid > 0 && isAlive(toolPid)) {
            const commandLine = spawnSync("ps", ["-o", "command=", "-p", String(toolPid)], { encoding: "utf8" }).stdout.trim();
            if (commandLine === "sleep 45") {
                process.kill(toolPid, "SIGTERM");
                await waitUntil(() => !isAlive(toolPid!), "private trial tool exit", 10_000);
            }
        }
        stub.stop(true);
        await waitUntil(() => {
            const processes = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout;
            return !processes.split("\n").some((line) => line.includes("vera-watchdog") && line.includes(root));
        }, "private trial watchdog exit", 10_000);
        rmSync(root, { recursive: true, force: true });
    }
}, 60_000);
