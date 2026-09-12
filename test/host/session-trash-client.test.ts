import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { startHostServer } from "../../src/host/server.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
    "resident host trashes a closed session out of the durable store",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-stored-trash-"));
        const socketPath = join(root, "host.sock");
        const sessionDirectory = join(root, "sessions");
        const trashed: string[] = [];
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
            sessionDirectory,
            eventLogDirectory: join(root, "logs"),
            trashSessionArtifacts: (artifacts) =>
                trashSessionArtifacts(artifacts, {
                    moveToTrash: async ([bundle]) => {
                        trashed.push(bundle);
                    },
                }),
        });
        const sessionPath = join(sessionDirectory, "saved.jsonl");
        try {
            await host.registry.create({ id: "saved", workspace: root });
            expect(await host.registry.closeAgent("saved")).toBe("closed");
            expect((await stat(sessionPath)).isFile()).toBe(true);

            expect(await trashSessionThroughHost(socketPath, "saved"))
                .toEqual({ status: "trashed" });

            expect(trashed).toHaveLength(1);
            expect(await stat(sessionPath).then(() => true, () => false))
                .toBe(false);
            expect((await listAgentsThroughHost(socketPath)).map((agent) =>
                agent.id
            )).not.toContain("saved");
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
