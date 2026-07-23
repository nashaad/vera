import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AgentStartError,
    branchAgentThroughHost,
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent startup client creates, resumes, forks, and clones",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-start-client-"));
        const socketPath = join(root, "host.sock");
        const created = new ResidentAgent("created", "/work/created");
        const resumed = new ResidentAgent("resumed", "/work/resumed");
        const branched = new ResidentAgent("branched", "/work/created");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            createAgent: async () => created,
            resumeAgent: async () => resumed,
            branchAgent: async (options) => ({
                agent: branched,
                ...(options.position === "at"
                    ? {}
                    : {
                        prompt: {
                            role: "user" as const,
                            content: [{
                                type: "text" as const,
                                text: "edit me",
                            }],
                        },
                    }),
            }),
        });
        try {
            expect(await createAgentThroughHost(socketPath, "/work/created"))
                .toEqual({ id: "created", workspace: "/work/created" });
            expect(await resumeAgentThroughHost(
                socketPath,
                "/sessions/resumed.jsonl",
            )).toEqual({ id: "resumed", workspace: "/work/resumed" });
            expect(await branchAgentThroughHost(
                socketPath,
                "created",
                "before",
                "message-2",
            )).toEqual({
                id: "branched",
                workspace: "/work/created",
                prompt: {
                    role: "user",
                    content: [{ type: "text", text: "edit me" }],
                },
            });
            expect(await branchAgentThroughHost(
                socketPath,
                "created",
                "at",
            )).toEqual({
                id: "branched",
                workspace: "/work/created",
            });
        } finally {
            created.close();
            resumed.close();
            branched.close();
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent startup client preserves the failed operation",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-start-client-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            createAgent: () => Promise.reject(new Error("private")),
        });
        try {
            await expect(createAgentThroughHost(socketPath, "/missing"))
                .rejects.toMatchObject({
                    name: AgentStartError.name,
                    operation: "create",
                });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
