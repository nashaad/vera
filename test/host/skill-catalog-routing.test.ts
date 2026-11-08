import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_SKILL_COMMANDS } from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface Harness {
    readonly agent: ResidentAgent;
    readonly socketPath: string;
    readonly server: { close(): Promise<void> };
    readonly release: () => void;
    readonly close: () => Promise<void>;
}

async function startHarness(gated: boolean): Promise<Harness> {
    const directory = mkdtempSync(join(tmpdir(), "skillcat-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(agent.engine));
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    new InboundCommandRouter(agent.engine, events, {
        listSkills: async () => {
            if (gated) await gate;
            return {
                skills: [{
                    name: "deploy",
                    description: "Deploy the service.",
                    disableModelInvocation: true,
                }],
                warnings: [],
            };
        },
        invokeSkill: async () => ({ allowed: true }),
    });
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SKILL_COMMANDS],
        findAgent: () => agent,
    });
    return {
        agent,
        socketPath,
        server,
        release: () => open(),
        close: async () => {
            agent.close();
            await server.close();
        },
    };
}

async function attach(harness: Harness, clientId: string): Promise<AttachedAgentClient> {
    const client = await attachAgent({
        socketPath: harness.socketPath,
        agentId: harness.agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SKILL_COMMANDS],
        clientId,
    });
    expect((await client.receive()).type).toBe("history");
    return client;
}

async function receiveCatalog(
    client: AttachedAgentClient,
    requestId: string,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 10_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for skill_catalog");
        const update = await Promise.race([
            client.receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for skill_catalog");
            }),
        ]);
        if (update.type === "skill_catalog" && update.requestId === requestId) {
            return update;
        }
    }
}

const skipInSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test;

skipInSandbox("requester gets skill_catalog when a second client attached before the request", async () => {
    const harness = await startHarness(false);
    const a = await attach(harness, "client-a");
    const b = await attach(harness, "client-b");
    try {
        await a.send({ type: "list_skills", requestId: "skills-a" });
        expect(await receiveCatalog(a, "skills-a")).toMatchObject({
            requestId: "skills-a",
            skills: [{ name: "deploy" }],
        });
    } finally {
        a.close();
        b.close();
        await harness.close();
    }
});

skipInSandbox("requester gets skill_catalog when a second client attaches while the request is in flight", async () => {
    const harness = await startHarness(true);
    const a = await attach(harness, "client-a");
    try {
        await a.send({ type: "list_skills", requestId: "skills-a" });
        const b = await attach(harness, "client-b");
        harness.release();
        try {
            expect(await receiveCatalog(a, "skills-a")).toMatchObject({
                requestId: "skills-a",
                skills: [{ name: "deploy" }],
            });
        } finally {
            b.close();
        }
    } finally {
        a.close();
        await harness.close();
    }
});

skipInSandbox("requester gets skill_catalog when a second client attaches just after the reply", async () => {
    const harness = await startHarness(false);
    const a = await attach(harness, "client-a");
    try {
        await a.send({ type: "list_skills", requestId: "skills-a" });
        expect(await receiveCatalog(a, "skills-a")).toMatchObject({
            requestId: "skills-a",
        });
        const b = await attach(harness, "client-b");
        b.close();
    } finally {
        a.close();
        await harness.close();
    }
});

skipInSandbox("requester gets skill_catalog on a fresh agent with a second client attached", async () => {
    const harness = await startHarness(false);
    const a = await attach(harness, "client-a");
    const b = await attach(harness, "client-b");
    try {
        await b.send({ type: "list_skills", requestId: "skills-b" });
        expect(await receiveCatalog(b, "skills-b")).toMatchObject({
            requestId: "skills-b",
            skills: [{ name: "deploy" }],
        });
        await a.send({ type: "list_skills", requestId: "skills-a" });
        expect(await receiveCatalog(a, "skills-a")).toMatchObject({
            requestId: "skills-a",
            skills: [{ name: "deploy" }],
        });
    } finally {
        a.close();
        b.close();
        await harness.close();
    }
});
