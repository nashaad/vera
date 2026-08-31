import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renameSessionThroughHost } from "../../src/host/session-rename-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { startHostServer } from "../../src/host/server.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
    "resident host renames a closed session in the durable store",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-stored-rename-"));
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            await host.registry.create({ id: "saved", workspace: root });
            expect(await host.registry.closeAgent("saved")).toBe("closed");

            expect(await renameSessionThroughHost(
                socketPath,
                "saved",
                "release notes",
            )).toEqual({ status: "renamed", name: "release notes" });
            expect((await listAgentsThroughHost(socketPath)).find((agent) =>
                agent.id === "saved"
            )?.title).toBe("release notes");
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
