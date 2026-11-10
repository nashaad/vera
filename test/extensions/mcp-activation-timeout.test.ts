import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServerClient } from "../../extensions/mcp/client.ts";
import { TokenStore } from "../../extensions/mcp/oauth.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { extensionStorage } from "../../src/extensions/storage.ts";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-reconnect-server.ts", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));

function pids(directory: string): number[] {
    const path = join(directory, "processes.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").trim().split("\n")
        .filter((line) => line.startsWith("start ")).map((line) => Number(line.slice(6)));
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP fixture");
        await Bun.sleep(10);
    }
}

test("a timed-out MCP activation leaves no server behind when the host restarts", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs7b-mcp-activation-"));
    const fast = join(home, "fast");
    await mkdir(fast);
    const responses: Array<(response: Response) => void> = [];
    const oauth = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch: () => new Promise<Response>((resolve) => { responses.push(resolve); }),
    });
    const machine = join(home, "machine");
    const store = new TokenStore(extensionStorage("vera.mcp", { profile: home, machine }).machine);
    store.write("slow", {
        accessToken: "expired", refreshToken: "refresh", expiresAt: 1,
        tokenEndpoint: `http://127.0.0.1:${oauth.port}/token`, clientId: "stub",
        resource: `http://127.0.0.1:${oauth.port}/mcp`,
    });
    const options = {
        extensions: [{ path: EXTENSION, enabled: true, config: { servers: {
            fast: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: fast } },
            slow: { url: `http://127.0.0.1:${oauth.port}/mcp`, auth: "oauth" },
        } } }],
        storageRoots: { profile: home, machine },
    };
    try {
        const firstStart = startExtensionRegistry(options);
        await waitFor(() => pids(fast).length === 1 && responses.length === 1);
        expect(pids(fast).filter(running)).toHaveLength(1);
        const first = await firstStart;
        await first.close();
        expect(pids(fast).filter(running)).toEqual([]);
        const secondStart = startExtensionRegistry(options);
        await waitFor(() => pids(fast).length === 2 && responses.length === 2);
        expect(pids(fast).filter(running)).toHaveLength(1);
        const second = await secondStart;
        await second.close();
        const live = pids(fast).filter(running);
        console.log(JSON.stringify({ fast: pids(fast), live, pendingRefreshes: responses.length }));
        expect(pids(fast)).toHaveLength(2);
        expect(live).toEqual([]);
    } finally {
        for (const resolve of responses) resolve(new Response(null, { status: 401 }));
        oauth.stop(true);
        const started = pids(fast);
        for (const pid of started) if (running(pid)) process.kill(pid, "SIGTERM");
        const deadline = Date.now() + 5_000;
        while (started.some(running) && Date.now() < deadline) await Bun.sleep(10);
        console.log(JSON.stringify({ stopped: started.filter((pid) => !running(pid)), stillLive: started.filter(running) }));
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 20_000);

test("a connection completing after the registry closed is not retained", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs7b-mcp-late-"));
    const connected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const originalConnect = McpServerClient.prototype.connect;
    McpServerClient.prototype.connect = async function (signal?: AbortSignal) {
        await originalConnect.call(this, signal);
        connected.resolve();
        await release.promise;
        completed.resolve();
    };
    try {
        const starting = startExtensionRegistry({
            extensions: [{ path: EXTENSION, enabled: true, config: { servers: {
                fast: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: home } },
            } } }],
            storageRoots: { profile: home, machine: join(home, "machine") },
            activationTimeoutMs: 1_000,
        });
        await connected.promise;
        expect(pids(home).filter(running)).toHaveLength(1);
        const registry = await starting;
        await registry.close();
        expect(pids(home).filter(running)).toEqual([]);
        release.resolve();
        await completed.promise;
        await Bun.sleep(10);
        expect(registry.tools()).toEqual([]);
        expect(pids(home).filter(running)).toEqual([]);
    } finally {
        release.resolve();
        McpServerClient.prototype.connect = originalConnect;
        const started = pids(home);
        for (const pid of started) if (running(pid)) process.kill(pid, "SIGTERM");
        await waitFor(() => started.every((pid) => !running(pid)));
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 10_000);

test("an installed MCP copy closes its clients when activation times out", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs7b-mcp-copy-"));
    const copy = join(home, "copy");
    const fast = join(home, "fast");
    const slow = join(home, "slow");
    await cp(EXTENSION, copy, { recursive: true });
    await mkdir(fast);
    await mkdir(slow);
    await writeFile(join(slow, "hold"), "");
    try {
        const starting = startExtensionRegistry({
            extensions: [{ path: copy, enabled: true, config: { servers: {
                fast: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: fast } },
                slow: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: slow } },
            } } }],
            storageRoots: { profile: home, machine: join(home, "machine") },
            activationTimeoutMs: 1_000,
        });
        await waitFor(() => pids(fast).length === 1 && pids(slow).length === 1);
        const registry = await starting;
        expect([...pids(fast), ...pids(slow)].filter(running)).toEqual([]);
        await registry.close();
    } finally {
        const started = [...pids(fast), ...pids(slow)];
        for (const pid of started) if (running(pid)) process.kill(pid, "SIGTERM");
        await waitFor(() => started.every((pid) => !running(pid)));
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 10_000);
