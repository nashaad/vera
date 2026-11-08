import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { HOST_MIN_COMPATIBLE_PROTOCOL_VERSION, HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";
import { startHostServer } from "../../src/host/server.ts";

async function identityLine(socketPath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let data = "";
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write('{"type":"host_identity"}\n'));
        socket.on("data", (chunk) => { data += chunk; });
        socket.once("error", reject);
        socket.once("end", () => resolve(data));
    });
}

test("a plain host preserves the lock, identity and ls bytes", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-plain-");
    const socketPath = join(home, "host.sock");
    const lockPath = join(home, "host.json");
    const startedAt = "2026-07-17T12:00:00.000Z";
    const server = await startHostServer({ socketPath, lockPath, pid: process.pid, startedAt, buildId: "test-build" });
    try {
        expect(await readFile(lockPath, "utf8")).toBe(`${JSON.stringify({
            schema_version: 3, pid: process.pid, started_at: startedAt, socket_path: socketPath, build_id: "test-build",
        }, null, 2)}\n`);
        expect(await identityLine(socketPath)).toBe(`${JSON.stringify({
            type: "host_identity", pid: process.pid, started_at: startedAt,
            protocol_version: HOST_PROTOCOL_VERSION,
            minimum_compatible_protocol_version: HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
            build_id: "test-build", role: "host",
        })}\n`);
        let output = "";
        expect(await runCli(["ls"], { listAgentPage: async () => ({ agents: [] }), stdout: { write: (text) => { output += text; } } })).toBe(0);
        expect(output).toBe("No Vera agents in this workspace. Use --all to see every one.\n");
    } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("a pool host publishes schema 3 with its role and process count", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-lock-");
    const socketPath = join(home, "host.sock");
    const lockPath = join(home, "host.json");
    const server = await startHostServer({
        socketPath, lockPath, pid: process.pid, startedAt: "2026-07-17T12:00:00.000Z", buildId: "test-build", poolWorkerCount: 3,
    });
    try {
        expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ schema_version: 3, role: "host", worker_count: 3 });
        expect(JSON.parse(await identityLine(socketPath))).toMatchObject({ type: "host_identity", role: "host", worker_count: 3 });
    } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
    }
});
