import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { startHostServer } from "../../src/host/server.ts";

const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

socketTest(
    "agent close client preserves typed host outcomes",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-agent-close-client-"));
        const socketPath = join(root, "host.sock");
        const calls: string[] = [];
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            closeAgent: async (targetId) => {
                calls.push(targetId);
                if (targetId === "live") return "closed";
                if (targetId === "theirs") return "not_owned";
                if (targetId === "wedged") return "failed";
                return "not_found";
            },
        });

        try {
            expect(await closeAgentThroughHost(socketPath, "live"))
                .toEqual({ status: "closed" });
            expect(await closeAgentThroughHost(socketPath, "ghost"))
                .toEqual({ status: "rejected", reason: "not_found" });
            expect(await closeAgentThroughHost(socketPath, "theirs"))
                .toEqual({ status: "rejected", reason: "not_owned" });
            expect(await closeAgentThroughHost(socketPath, "wedged"))
                .toEqual({ status: "rejected", reason: "failed" });
            expect(calls).toEqual(["live", "ghost", "theirs", "wedged"]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest(
    "agent close client normalizes transport failure",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-agent-close-client-"));
        try {
            expect(await closeAgentThroughHost(
                join(root, "missing.sock"),
                "live",
            )).toEqual({ status: "rejected", reason: "failed" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest(
    "a host with no close handler reports the id as unknown",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-agent-close-client-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
        });
        try {
            expect(await closeAgentThroughHost(socketPath, "live"))
                .toEqual({ status: "rejected", reason: "not_found" });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
