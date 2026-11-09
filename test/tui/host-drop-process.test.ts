import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { connectHost } from "../../src/host/connection.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";

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

interface ClientLogEvent {
    readonly type?: string;
    readonly outcome?: string;
    readonly sessionId?: string;
}

function isAlive(pid: number): boolean {
    const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    const status = result.stdout.trim();
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
    const result = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
    return result.stdout.includes(`VERA_HOME=${trialHome}`) && result.stdout.includes("vera-host");
}

function verifiedWorker(pid: number, trialHome: string): boolean {
    const result = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
    return result.stdout.includes(`VERA_HOME=${trialHome}`) && result.stdout.includes("session-worker");
}

function workerPids(trialHome: string): number[] {
    const directory = join(trialHome, "runtime", "workers");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json")).flatMap((name) => {
        try {
            const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as { pid?: unknown };
            return typeof record.pid === "number" ? [record.pid] : [];
        } catch { return []; }
    });
}

async function waitUntil(check: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!check()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(25);
    }
}

const realProcessTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    || process.platform === "win32"
    || spawnSync("tmux", ["-V"]).status !== 0
    ? test.skip : test;

realProcessTest(
    "a killed host reconnects without rendering an empty conversation",
    async () => {
        const tempBase = join(tmpdir(), "vera-dev");
        mkdirSync(tempBase, { recursive: true });
        const root = mkdtempSync(join(tempBase, "hostdrop-test-"));
        const trialHome = join(root, "h");
        const socket = join(root, "tmux.sock");
        const toolPidPath = join(root, "tool.pid");
        const env = {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: root,
            VERA_HOME: trialHome,
            VERA_DEV_INSTANCE: `${basename(process.cwd())} dev`,
            TMPDIR: root,
            TERM: "xterm-256color",
        };
        mkdirSync(trialHome, { recursive: true });
        const command = `echo $$ > '${toolPidPath}'; exec sleep 30`;
        const stub = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                if (request.method === "GET") {
                    return Response.json({ data: [{ id: "stub-model" }] });
                }
                const body = await request.json() as StubRequest;
                const classifier = body.messages?.[0]?.role === "system"
                    && typeof body.messages[0].content === "string"
                    && body.messages[0].content.startsWith("You review one proposed action");
                const hasResult = body.messages?.some((message) => message.role === "tool") === true;
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
        const pane = (): string => tmux("capture-pane", "-p", "-t", "hostdrop").stdout;
        let killedHost: number | undefined;
        let toolPid: number | undefined;
        try {
            const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "hostdrop", "-x", "120", "-y", "40",
                "-c", process.cwd(), "bun clients/cli/main.ts");
            if (started.status !== 0) throw new Error(started.stderr);
            await waitUntil(() => pane().includes("or just start typing"), "home");
            tmux("send-keys", "-t", "hostdrop", "-l", "A crow starts a slow voyage");
            tmux("send-keys", "-t", "hostdrop", "Enter");
            await waitUntil(() => pane().includes("running bash") && existsSync(toolPidPath), "running bash");
            toolPid = Number(readFileSync(toolPidPath, "utf8").trim());
            killedHost = readHostPid(trialHome);
            if (killedHost === undefined || !verifiedHost(killedHost, trialHome)) {
                throw new Error("Could not verify the trial host");
            }
            const startedAt = performance.now();
            process.kill(killedHost, "SIGKILL");
            let reconnectAt: number | undefined;
            const frames: string[] = [];
            await waitUntil(() => {
                const frame = pane();
                frames.push(frame);
                if (reconnectAt === undefined && frame.includes("reconnecting…")) {
                    reconnectAt = performance.now() - startedAt;
                }
                return frame.includes("Vera crashed before this turn finished.");
            }, "crash repair");
            expect(reconnectAt).toBeDefined();
            expect(reconnectAt!).toBeLessThan(2_000);
            expect(frames.some((frame) => frame.includes("Start a conversation with Vera."))).toBeFalse();
            expect(frames.some((frame) => frame.includes("Lost the connection to the host."))).toBeFalse();
            expect(frames.at(-1)).toContain("A crow starts a slow voyage");
            expect(readHostPid(trialHome)).not.toBe(killedHost);

            await Bun.sleep(350);
            const directory = join(trialHome, "runtime/logs/clients");
            const events = readdirSync(directory).filter((name) => name.endsWith(".jsonl"))
                .flatMap((name) => readFileSync(join(directory, name), "utf8").trim().split("\n"))
                .filter(Boolean)
                .map((line) => JSON.parse(line) as ClientLogEvent);
            const losses = events.filter((event) => event.type === "host_connection_lost");
            const outcomes = events.filter((event) => event.type === "host_restart_outcome");
            expect(losses).toHaveLength(1);
            expect(outcomes).toEqual([expect.objectContaining({ outcome: "completed" })]);
            expect(outcomes[0]?.sessionId).toBe(losses[0]?.sessionId);
            tmux("send-keys", "-t", "hostdrop", "C-c");
            await Bun.sleep(200);
            tmux("send-keys", "-t", "hostdrop", "C-c");
            await waitUntil(() => tmux("has-session", "-t", "hostdrop").status !== 0, "TUI exit", 10_000);
        } finally {
            tmux("kill-server");
            const currentHost = readHostPid(trialHome);
            if (currentHost !== undefined && isAlive(currentHost) && verifiedHost(currentHost, trialHome)) {
                process.kill(currentHost, "SIGTERM");
                await waitUntil(() => !isAlive(currentHost), "trial host exit", 10_000);
            }
            if (killedHost !== undefined) {
                const oldHost = killedHost;
                await waitUntil(() => !isAlive(oldHost), "killed host exit", 10_000);
            }
            if (toolPid === undefined && existsSync(toolPidPath)) {
                toolPid = Number(readFileSync(toolPidPath, "utf8").trim());
            }
            if (toolPid !== undefined && Number.isSafeInteger(toolPid) && toolPid > 0 && isAlive(toolPid)) {
                const commandLine = spawnSync("ps", ["-o", "command=", "-p", String(toolPid)], { encoding: "utf8" }).stdout.trim();
                if (commandLine === "sleep 30") {
                    process.kill(toolPid, "SIGTERM");
                    await waitUntil(() => !isAlive(toolPid!), "trial tool exit", 10_000);
                }
            }
            stub.stop(true);
            await waitUntil(() => {
                const processes = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout;
                return !processes.split("\n").some((line) => line.includes("vera-watchdog") && line.includes(root));
            }, "trial watchdog exit", 10_000);
            rmSync(root, { recursive: true, force: true });
        }
    },
    60_000,
);

realProcessTest(
    "a surviving session process finishes a turn after the TUI reconnects the master",
    async () => {
        const tempBase = join(tmpdir(), "vera-dev");
        mkdirSync(tempBase, { recursive: true });
        const root = mkdtempSync(join(tempBase, "hostdrop-pool-"));
        const trialHome = join(root, "h");
        const socket = join(root, "tmux.sock");
        const env = {
            PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, VERA_HOME: trialHome,
            VERA_DEV_INSTANCE: `${basename(process.cwd())} dev`, TMPDIR: root, TERM: "xterm-256color",
        };
        mkdirSync(trialHome, { recursive: true });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const stub = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(request) {
                if (request.method === "GET") return Response.json({ data: [{ id: "stub-model" }] });
                entered.resolve();
                await release.promise;
                return new Response('data: {"id":"stub","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow completes the voyage."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
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
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        }));
        const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { cwd: process.cwd(), env, encoding: "utf8" });
        const pane = (): string => tmux("capture-pane", "-p", "-t", "hostdrop-pool").stdout;
        let killedHost: number | undefined;
        let workerPid: number | undefined;
        const startedWorkers = new Set<number>();
        try {
            const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "hostdrop-pool", "-x", "120", "-y", "40",
                "-c", process.cwd(), "bun clients/cli/main.ts");
            if (started.status !== 0) throw new Error(started.stderr);
            await waitUntil(() => pane().includes("or just start typing"), "home");
            tmux("send-keys", "-t", "hostdrop-pool", "-l", "A crow begins a voyage");
            tmux("send-keys", "-t", "hostdrop-pool", "Enter");
            await Promise.race([entered.promise, Bun.sleep(30_000).then(() => { throw new Error("Provider request did not start"); })]);
            const directory = join(trialHome, "runtime", "sessions");
            const names = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
            expect(names).toHaveLength(1);
            const sessionId = names[0]!.slice(0, -".jsonl".length);
            const hostSocket = join(trialHome, "runtime", "host.sock");
            const connection = await connectHost({ socketPath: hostSocket });
            let workerSocket: string;
            try {
                await connection.send({ type: "locate_agent", agent_id: sessionId });
                const response = await connection.receiveWithin(5_000, "Locate timed out") as { type: string; socket_path?: string };
                expect(response.type).toBe("agent_location");
                if (response.socket_path === undefined) throw new Error("Session process socket is unavailable");
                workerSocket = response.socket_path;
            } finally { connection.close(); }
            workerPid = (await requestHostIdentity(workerSocket))?.pid;
            expect(workerPid).toBeDefined();
            for (const pid of workerPids(trialHome)) startedWorkers.add(pid);
            killedHost = readHostPid(trialHome);
            if (killedHost === undefined || !verifiedHost(killedHost, trialHome)) throw new Error("Could not verify the trial host");
            process.kill(killedHost, "SIGKILL");
            await waitUntil(() => !isAlive(killedHost!), "master exit");
            expect(isAlive(workerPid!)).toBe(true);
            tmux("send-keys", "-t", "hostdrop-pool", "C-p");
            await waitUntil(() => pane().includes("Commands"), "commands");
            tmux("send-keys", "-t", "hostdrop-pool", "-l", "reconnect host");
            await waitUntil(() => pane().includes("Reconnect host"), "reconnect command");
            tmux("send-keys", "-t", "hostdrop-pool", "Enter");
            await waitUntil(() => {
                const pid = readHostPid(trialHome);
                return pid !== undefined && pid !== killedHost;
            }, "replacement master");
            for (const pid of workerPids(trialHome)) startedWorkers.add(pid);
            expect((await requestHostIdentity(workerSocket))?.pid).toBe(workerPid);
            release.resolve();
            await waitUntil(() => pane().includes("The crow completes the voyage."), "completed turn");
            expect(pane()).toContain("A crow begins a voyage");
            expect(pane()).not.toContain("Vera crashed before this turn finished.");
        } finally {
            release.resolve();
            tmux("kill-server");
            const currentHost = readHostPid(trialHome);
            if (currentHost !== undefined && isAlive(currentHost) && verifiedHost(currentHost, trialHome)) {
                process.kill(currentHost, "SIGTERM");
                await waitUntil(() => !isAlive(currentHost), "trial host exit", 10_000);
            }
            for (const pid of workerPids(trialHome)) startedWorkers.add(pid);
            for (const pid of startedWorkers) {
                if (isAlive(pid) && verifiedWorker(pid, trialHome)) process.kill(pid, "SIGTERM");
            }
            if (killedHost !== undefined) await waitUntil(() => !isAlive(killedHost!), "killed host exit", 10_000);
            for (const pid of startedWorkers) await waitUntil(() => !isAlive(pid), `session process ${pid} exit`, 10_000);
            stub.stop(true);
            rmSync(root, { recursive: true, force: true });
        }
    },
    90_000,
);
