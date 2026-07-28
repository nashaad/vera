import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renameSessionThroughHost } from "../../src/host/session-rename-client.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session rename client preserves typed host outcomes",
    async () => {
        const root = await mkdtemp(
            join(tmpdir(), "vera-session-rename-client-"),
        );
        const socketPath = join(root, "host.sock");
        const calls: (string | null)[][] = [];
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            renameSession: async (targetId, name) => {
                calls.push([targetId, name]);
                if (targetId === "attached") {
                    return { status: "busy" };
                }
                return targetId === "saved"
                    ? { status: "renamed", name }
                    : { status: "not_found" };
            },
        });

        try {
            expect(await renameSessionThroughHost(
                socketPath,
                "saved",
                "release notes",
            )).toEqual({ status: "renamed", name: "release notes" });
            expect(await renameSessionThroughHost(
                socketPath,
                "saved",
                null,
            )).toEqual({ status: "renamed", name: null });
            expect(await renameSessionThroughHost(
                socketPath,
                "gone",
                "release notes",
            )).toEqual({ status: "rejected", reason: "not_found" });
            expect(await renameSessionThroughHost(
                socketPath,
                "attached",
                "release notes",
            )).toEqual({ status: "rejected", reason: "busy" });
            expect(calls).toEqual([
                ["saved", "release notes"],
                ["saved", null],
                ["gone", "release notes"],
                ["attached", "release notes"],
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "session rename client normalizes transport failure",
    async () => {
        const root = await mkdtemp(
            join(tmpdir(), "vera-session-rename-client-"),
        );
        try {
            expect(await renameSessionThroughHost(
                join(root, "missing.sock"),
                "saved",
                "release notes",
            )).toEqual({ status: "rejected", reason: "failed" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
