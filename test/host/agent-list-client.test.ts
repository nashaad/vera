import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
            }],
        });
        try {
            expect(await listAgentsThroughHost(socketPath)).toEqual([{
                id: "agent-1",
                workspace: "/work/one",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "working",
            }]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
