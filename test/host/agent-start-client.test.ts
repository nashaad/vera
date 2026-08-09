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
import { UserFacingError } from "../../src/user-facing-error.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent startup client creates, resumes, forks, and clones",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-start-client-"));
        const socketPath = join(root, "host.sock");
        const created = new ResidentAgent("created", "/work/created");
        const resumed = new ResidentAgent("resumed", "/work/resumed");
        const branched = new ResidentAgent("branched", "/work/created");
        let createOptions: unknown;
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            createAgent: async (options) => {
                createOptions = options;
                return created;
            },
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
            expect(await createAgentThroughHost(
                socketPath,
                "/work/created",
                "readonly",
                "ephemeral",
            ))
                .toEqual({ id: "created", workspace: "/work/created" });
            expect(createOptions).toEqual({
                workspace: "/work/created",
                approvalMode: "readonly",
                ephemeral: true,
            });
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

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the reason reaches the caller as the message it will print",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-start-client-"));
        const socketPath = join(root, "host.sock");
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            createAgent: () =>
                Promise.reject(
                    new UserFacingError(
                        "No credentials for provider openrouter. Connect it from the model pane (ctrl+e).",
                    ),
                ),
        });
        try {
            // The CLI prints error.message, so the reason has to be the message
            // rather than a field somebody has to remember to read.
            await expect(createAgentThroughHost(socketPath, "/missing"))
                .rejects.toMatchObject({
                    name: AgentStartError.name,
                    operation: "create",
                    message:
                        "No credentials for provider openrouter. Connect it from the model pane (ctrl+e).",
                });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
