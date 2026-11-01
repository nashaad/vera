import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trashSessionThroughHost } from "../../src/host/session-trash-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { AgentAttachError, attachAgent } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { startHostServer } from "../../src/host/server.ts";
import { emptyUsage } from "../../src/model/types.ts";
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
                    moveToTrash: async (paths) => {
                        const [bundle] = paths;
                        if (bundle === undefined) {
                            throw new Error("expected a trash bundle path");
                        }
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

async function trashParentOfFinishedChild(
    root: string,
    childSessionPath: string | undefined,
): Promise<void> {
    const socketPath = join(root, "host.sock");
    const sessionDirectory = join(root, "sessions");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter(
            Array.from({ length: 4 }, () => ({
                role: "assistant" as const,
                content: [{
                    type: "text" as const,
                    text: "The crow is done.",
                }],
                source: {
                    provider: "faux",
                    api: "scripted",
                    model: "test",
                },
                usage: emptyUsage(),
                stopReason: "stop" as const,
            })),
        ),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory,
        eventLogDirectory: join(root, "logs"),
        trashSessionArtifacts: (artifacts) =>
            trashSessionArtifacts(artifacts, { moveToTrash: async () => {} }),
    });
    try {
        await host.registry.create({ id: "parent", workspace: root });
        await host.registry.createWithKind(
            {
                id: "child",
                workspace: root,
                ...(childSessionPath === undefined
                    ? {}
                    : { sessionPath: childSessionPath }),
            },
            "background",
            { approvalMode: "auto", parentId: "parent" },
        );
        host.registry.find("child")!.sendPrompt("bury the treasure");
        host.registry.trackAsyncSubagentTurn("child");
        const deadline = Date.now() + 3_000;
        while (
            !host.registry.list().every((agent) =>
                host.registry.find(agent.id)?.idleForShutdown() === true
            )
            || host.registry.list().find((agent) => agent.id === "child")
                ?.status !== "completed"
        ) {
            if (Date.now() > deadline) {
                throw new Error("the child did not finish");
            }
            await Bun.sleep(10);
        }

        expect(await trashSessionThroughHost(socketPath, "parent"))
            .toEqual({ status: "trashed" });

        expect(host.registry.list()).toEqual([]);
        expect(await stat(join(sessionDirectory, "parent.jsonl"))
            .then(() => true, () => false)).toBe(false);
        await expect(attachAgent({ socketPath, agentId: "parent" }))
            .rejects.toBeInstanceOf(AgentAttachError);
        const listed = await listAgentsThroughHost(socketPath);
        expect(listed.map((agent) => agent.id)).toEqual(["child"]);
        expect(listed[0]).toMatchObject({
            live: false,
            session_path: childSessionPath
                ?? join(sessionDirectory, "child.jsonl"),
        });
        const client = await attachAgent({ socketPath, agentId: "child" });
        expect(client.agentId).toBe("child");
        client.close();
    } finally {
        await host.close();
    }
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host keeps a finished child listed after its parent is trashed",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-trash-finished-child-"));
        try {
            await trashParentOfFinishedChild(root, undefined);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "resident host lists a finished child by its own session path after its parent is trashed",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-trash-elsewhere-child-"));
        try {
            await trashParentOfFinishedChild(
                root,
                join(root, "elsewhere", "child.jsonl"),
            );
        } finally {
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
