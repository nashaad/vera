import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentPageThroughHost } from "../../src/host/agent-list-client.ts";
import {
    InteractiveAttachmentCoordinator,
    type AttachmentCoordinator,
} from "../../src/host/attachment-coordinator.ts";
import { startHostServer } from "../../src/host/server.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { socketTest } from "../support/socket-probe.ts";

function agent(
    id: string,
    live: boolean,
): RegisteredAgentSummary {
    return {
        id,
        workspace: "/work/one",
        session_path: `/sessions/${id}.jsonl`,
        kind: "interactive",
        status: live ? "idle" : "closed",
        live,
    };
}

async function listWith(
    coordinator: AttachmentCoordinator,
): Promise<Awaited<ReturnType<typeof listAgentPageThroughHost>>> {
    const root = await mkdtemp(join(tmpdir(), "vera-attachment-counts-"));
    const host = await startHostServer({
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        listAgents: () => [agent("one", true), agent("two", true), agent("old", false)],
        attachmentCoordinator: coordinator,
    });
    try {
        return await listAgentPageThroughHost(host.socketPath);
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}

const noClose: ConstructorParameters<typeof InteractiveAttachmentCoordinator>[1] =
    () => Promise.resolve({ status: "not_found" });

socketTest("@core agent listing counts attached clients per conversation and across the page", async () => {
    const coordinator = new InteractiveAttachmentCoordinator(
        async () => (id) => [id],
        noClose,
    );
    // Two leases from one client still count as one client on that conversation.
    await coordinator.open("one", "client-a");
    await coordinator.open("one", "client-a");
    await coordinator.open("one", "client-b");
    await coordinator.open("two", "client-a");

    const page = await listWith(coordinator);

    expect(page.connectedClients).toBe(2);
    expect(page.agents.find((row) => row.id === "one")?.attached_clients).toBe(2);
    expect(page.agents.find((row) => row.id === "two")?.attached_clients).toBe(1);
    expect("attached_clients" in page.agents.find((row) => row.id === "old")!).toBe(false);
});

socketTest("@core agent listing leaves the client counts out when the host has none", async () => {
    const coordinator: AttachmentCoordinator = {
        open: () => Promise.resolve("lease"),
        detach: () => Promise.resolve([]),
        abandon: () => Promise.resolve(),
        ready: () => Promise.resolve([]),
        release: () => Promise.resolve({ remaining: 0, rootsToStop: [] }),
        closeIfReady: () => Promise.resolve({ status: "not_found" }),
    };

    const page = await listWith(coordinator);

    expect(page.connectedClients).toBeUndefined();
    expect(page.agents.some((row) => "attached_clients" in row)).toBe(false);
});
