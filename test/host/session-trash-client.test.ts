import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session trash client preserves typed host outcomes",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-trash-client-"));
        const socketPath = join(root, "host.sock");
        const calls: string[] = [];
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            trashSession: async (targetId) => {
                calls.push(targetId);
                return targetId === "saved" ? "trashed" : "busy";
            },
        });

        try {
            expect(await trashSessionThroughHost(
                socketPath,
                "saved",
            )).toEqual({ status: "trashed" });
            expect(await trashSessionThroughHost(
                socketPath,
                "working",
            )).toEqual({ status: "rejected", reason: "busy" });
            expect(calls).toEqual([
                "saved",
                "working",
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session trash client normalizes transport failure",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-trash-client-"));
        try {
            expect(await trashSessionThroughHost(
                join(root, "missing.sock"),
                "saved",
            )).toEqual({ status: "rejected", reason: "failed" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
