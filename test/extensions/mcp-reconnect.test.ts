import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServerClient } from "../../extensions/mcp/client.ts";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-reconnect-server.ts", import.meta.url));

interface Fixture {
    readonly directory: string;
    readonly client: McpServerClient;
    pids(): number[];
    hold(): Promise<void>;
    release(): Promise<void>;
    waitForServer(): Promise<void>;
    exitServer(): Promise<void>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
    const directory = await mkdtemp("/private/tmp/vera-dev/hs7b-mcp-");
    const client = new McpServerClient({
        kind: "stdio", name: "stub", command: [process.execPath, SERVER],
        env: { MCP_RECONNECT_FIXTURE: directory },
    });
    const events = (): string[] => existsSync(join(directory, "processes.log"))
        ? readFileSync(join(directory, "processes.log"), "utf8").trim().split("\n") : [];
    const pids = (): number[] => events().filter((line) => line.startsWith("start "))
        .map((line) => Number(line.slice(6)));
    const fixture: Fixture = {
        directory, client, pids,
        hold: () => writeFile(join(directory, "hold"), ""),
        release: () => rm(join(directory, "hold"), { force: true }),
        waitForServer: () => waitFor(() => events().some((line) => line.startsWith("waiting "))),
        async exitServer() {
            const previous = pids().at(-1)!;
            await client.callTool("exit", {}, new AbortController().signal).catch(() => {});
            await waitFor(() => !running(previous));
        },
    };
    try {
        await client.connect();
        await run(fixture);
    } finally {
        await client.close();
        const started = pids();
        await waitFor(() => started.every((pid) => !running(pid)), 18_000);
        expect(started.filter(running)).toEqual([]);
        await rm(directory, { recursive: true, force: true });
    }
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, timeout = 5_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP fixture");
        await Bun.sleep(10);
    }
}

test("concurrent tool, prompt, resource and explicit connections share one replacement", async () => {
    await withFixture(async ({ client, pids, hold, release, waitForServer, exitServer }) => {
        await exitServer();
        await hold();
        const signal = new AbortController().signal;
        const calls = Promise.all([
            client.callTool("echo", {}, signal),
            client.getPrompt("greet", {}, signal),
            client.readResource("test:resource", signal),
            client.connect(signal),
        ]);
        await waitForServer();
        await release();
        const [tool, prompt, resource] = await calls;
        expect(pids()).toHaveLength(2);
        expect(tool.text).toBe(String(pids()[1]));
        expect(prompt).toBe(tool.text);
        expect(resource).toBe(tool.text);
        await client.connect();
        expect(pids()).toHaveLength(2);
    });
}, 30_000);

test("one caller can abort while another waits for the same connection", async () => {
    await withFixture(async ({ client, pids, hold, release, waitForServer, exitServer }) => {
        await exitServer();
        await hold();
        const controller = new AbortController();
        const aborted = client.callTool("echo", {}, controller.signal).then(() => "resolved", (error: Error) => error.name);
        const other = client.callTool("echo", {}, new AbortController().signal);
        await waitForServer();
        controller.abort();
        expect(await aborted).toBe("AbortError");
        await release();
        expect((await other).text).toBe(String(pids()[1]));
        expect(pids()).toHaveLength(2);
    });
}, 30_000);

test("the last abort closes the attempted server and the next call reconnects", async () => {
    await withFixture(async ({ client, pids, hold, release, waitForServer, exitServer }) => {
        await exitServer();
        await hold();
        const first = new AbortController();
        const second = new AbortController();
        const calls = [first, second].map((controller) =>
            client.callTool("echo", {}, controller.signal).then(() => "resolved", (error: Error) => error.name));
        await waitForServer();
        first.abort();
        second.abort();
        expect(await Promise.all(calls)).toEqual(["AbortError", "AbortError"]);
        await waitFor(() => pids().length === 2 && !running(pids()[1]!));
        await release();
        expect((await client.callTool("echo", {}, new AbortController().signal)).text).toBe(String(pids()[2]));
        expect(pids()).toHaveLength(3);
    });
}, 30_000);

test("a failed shared connection fails every waiter and permits a fresh attempt", async () => {
    await withFixture(async ({ directory, client, pids, hold, release, waitForServer, exitServer }) => {
        await exitServer();
        await hold();
        const calls = [1, 2].map(() => client.callTool("echo", {}, new AbortController().signal)
            .then(() => "resolved", () => "failed"));
        await waitForServer();
        await writeFile(join(directory, "fail"), "");
        await release();
        expect(await Promise.all(calls)).toEqual(["failed", "failed"]);
        expect(pids()).toHaveLength(2);
        expect(running(pids()[1]!)).toBe(false);
        await rm(join(directory, "fail"));
        expect((await client.callTool("echo", {}, new AbortController().signal)).text).toBe(String(pids()[2]));
    });
}, 30_000);

test("close during a shared connection waits for its server to exit", async () => {
    await withFixture(async ({ client, pids, hold, waitForServer, exitServer }) => {
        await exitServer();
        await hold();
        const calls = [1, 2].map(() => client.callTool("echo", {}, new AbortController().signal)
            .then(() => "resolved", () => "failed"));
        await waitForServer();
        await client.close();
        expect(await Promise.all(calls)).toEqual(["failed", "failed"]);
        expect(pids()).toHaveLength(2);
        expect(pids().filter(running)).toEqual([]);
    });
}, 30_000);

test("HTTP callers share the same initialized session", async () => {
    let initializations = 0;
    const sessions: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const message = await request.json() as { id?: number; method: string };
            if (message.method === "initialize") initializations += 1;
            const session = request.headers.get("mcp-session-id");
            if (session !== null) sessions.push(session);
            const result = message.method === "tools/list" ? { tools: [] }
                : message.method === "prompts/list" ? { prompts: [] }
                : message.method === "tools/call" ? { content: [{ type: "text", text: "ok" }] }
                : message.method === "prompts/get" ? { messages: [{ content: { type: "text", text: "ok" } }] }
                : message.method === "resources/read" ? { contents: [{ text: "ok" }] } : {};
            return Response.json({ jsonrpc: "2.0", id: message.id, result }, {
                headers: { "mcp-session-id": `session-${initializations}` },
            });
        },
    });
    const client = new McpServerClient({ kind: "http", name: "stub", url: `http://127.0.0.1:${server.port}/mcp`, headers: {} });
    try {
        const signal = new AbortController().signal;
        await Promise.all([
            client.connect(signal), client.connect(signal), client.callTool("echo", {}, signal),
            client.getPrompt("greet", {}, signal), client.readResource("test:resource", signal),
        ]);
        expect(initializations).toBe(1);
        expect(sessions.every((session) => session === "session-1")).toBe(true);
        await client.close();
        await Promise.all([client.connect(signal), client.connect(signal)]);
        expect(initializations).toBe(2);
    } finally {
        await client.close();
        server.stop(true);
    }
});

test("closing during the HTTP initialized notification cancels the connection", async () => {
    const started = Promise.withResolvers<void>();
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const message = await request.json() as { id?: number; method: string };
            if (message.method === "notifications/initialized") {
                started.resolve();
                return await new Promise<Response>((resolve) => {
                    request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 202 })), { once: true });
                });
            }
            return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
        },
    });
    const client = new McpServerClient({ kind: "http", name: "stub", url: `http://127.0.0.1:${server.port}/mcp`, headers: {} });
    try {
        const waiting = client.connect().then(() => "resolved", () => "failed");
        await started.promise;
        await client.close();
        expect(await waiting).toBe("failed");
    } finally {
        await client.close();
        server.stop(true);
    }
}, 10_000);
