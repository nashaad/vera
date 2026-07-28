import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent list client validates host summaries",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-client-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            listAgents: () => [{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "working",
                live: true,
                title: "Background audit",
                updated_at: "2026-07-20T20:00:00.000Z",
            }, {
                id: "agent-2",
                workspace: "/work/one",
                session_path: "/sessions/agent-2.jsonl",
                kind: "interactive",
                status: "idle",
                live: false,
                title: "Forked audit",
                updated_at: "2026-07-20T20:05:00.000Z",
                forked_from: "agent-1",
            }],
        });
        try {
            const agents = await listAgentsThroughHost(socketPath);
            expect(agents[0]).toEqual({
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "working",
                live: true,
                title: "Background audit",
                updated_at: "2026-07-20T20:00:00.000Z",
            });
            expect(agents[1]?.forked_from).toBe("agent-1");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent list client rejects an unusable parent id",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-parent-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            listAgents: () => [{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "interactive",
                status: "idle",
                live: false,
                // An empty parent threads a row under nothing, so it is a
                // malformed summary rather than a row without a parent.
                forked_from: "",
            } as never],
        });
        try {
            await expect(listAgentsThroughHost(socketPath)).rejects.toThrow(
                "Host returned an invalid agent list",
            );
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent listing stops waiting when a host does not answer",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-list-timeout-"));
        const socketPath = join(root, "host.sock");
        const server = createServer(() => undefined);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });

        try {
            await expect(listAgentsThroughHost(socketPath, 10)).rejects.toThrow(
                "Host agent list deadline exceeded",
            );
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        }
    },
);
