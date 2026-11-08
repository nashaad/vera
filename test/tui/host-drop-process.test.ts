import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
