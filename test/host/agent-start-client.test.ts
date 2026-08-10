import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AgentBranchError,
    AgentStartError,
    branchAgentThroughHost,
    createAgentThroughHost,
    resumeAgentThroughHost,
} from "../../src/host/agent-start-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { UserFacingError } from "../../src/user-facing-error.ts";
import {
    HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
    HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
} from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "agent startup client creates, resumes, forks, and clones",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-start-client-"));
        const socketPath = join(root, "host.sock");
        const created = new ResidentAgent("created", "/work/created");
        const resumed = new ResidentAgent("resumed", "/work/resumed");
        const branched = new ResidentAgent("branched", "/work/created");
        let createOptions: unknown;
        const branchOptions: unknown[] = [];
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            capabilities: [
                HOST_CAPABILITY_AGENT_BRANCH_OPTIONS,
                HOST_CAPABILITY_AGENT_BRANCH_INITIAL_MESSAGES,
            ],
            commitBranch: () => true,
            createAgent: async (options) => {
                createOptions = options;
                return created;
            },
            resumeAgent: async () => resumed,
            branchAgent: async (options) => {
                branchOptions.push(options);
                return {
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
                };
            },
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
                undefined,
                {
                    approvalMode: "readonly",
                    lifetime: "ephemeral",
                    initialMessages: [{
                        role: "user",
                        content: [{ type: "text", text: "boundary" }],
                        internal: true,
                    }],
                },
            )).toEqual({
                id: "branched",
                workspace: "/work/created",
            });
            expect(branchOptions.at(-1)).toMatchObject({
                sourceId: "created",
                position: "at",
                approvalMode: "readonly",
                ephemeral: true,
                initialMessages: [{
                    role: "user",
                    content: [{ type: "text", text: "boundary" }],
                    internal: true,
                }],
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
    "an uncommitted optioned branch is discarded on disconnect",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-branch-commit-"));
        const socketPath = join(root, "host.sock");
        const branched = new ResidentAgent("pending", "/work/source");
        let discarded: string | undefined;
        let resolveDiscarded: (() => void) | undefined;
        const didDiscard = new Promise<void>((resolve) => {
            resolveDiscarded = resolve;
        });
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_BRANCH_OPTIONS],
            branchAgent: async () => ({ agent: branched }),
            discardBranch: async (agentId) => {
                discarded = agentId;
                branched.close();
                resolveDiscarded?.();
            },
        });
        try {
            const connection = await connectHost({ socketPath });
            await connection.send({
                type: "branch_agent",
                source_agent_id: "source",
                position: "at",
                lifetime: "ephemeral",
            });
            expect(await connection.receive()).toMatchObject({
                type: "agent_branched",
                agent_id: "pending",
                requires_commit: true,
            });
            connection.close();
            await didDiscard;
            expect(discarded).toBe("pending");
        } finally {
            branched.close();
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "branch options require host support",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-branch-options-"));
        const socketPath = join(root, "host.sock");
        let called = false;
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            branchAgent: async () => {
                called = true;
                return undefined;
            },
        });
        try {
            await expect(branchAgentThroughHost(
                socketPath,
                "source",
                "at",
                undefined,
                { lifetime: "ephemeral" },
            )).rejects.toMatchObject({
                name: AgentBranchError.name,
                reason: "unsupported_options",
            });
            expect(called).toBe(false);
            await expect(branchAgentThroughHost(
                socketPath,
                "source",
                "at",
                undefined,
                { lifetime: "durable" },
            )).rejects.toMatchObject({ reason: "source_unavailable" });
            expect(called).toBe(true);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "branch initial messages require their own host capability",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-branch-messages-"));
        const socketPath = join(root, "host.sock");
        let called = false;
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            capabilities: [HOST_CAPABILITY_AGENT_BRANCH_OPTIONS],
            branchAgent: async () => {
                called = true;
                return undefined;
            },
        });
        try {
            await expect(branchAgentThroughHost(
                socketPath,
                "source",
                "at",
                undefined,
                {
                    initialMessages: [{
                        role: "user",
                        content: [{ type: "text", text: "boundary" }],
                        internal: true,
                    }],
                },
            )).rejects.toMatchObject({
                name: AgentBranchError.name,
                reason: "unsupported_options",
            });
            expect(called).toBe(false);
        } finally {
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
