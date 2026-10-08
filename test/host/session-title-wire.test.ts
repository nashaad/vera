import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_SESSION_TITLE } from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-title-"));
    temporaryDirectories.push(directory);
    return directory;
}

function roster(title: string | undefined): RegisteredAgentSummary[] {
    return [{
        id: "agent-1",
        workspace: "/work/one",
        session_path: "/sessions/agent-1.jsonl",
        kind: "interactive",
        status: "idle",
        live: true,
        ...(title === undefined ? {} : { title }),
    }];
}

const networked = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

networked("a title change reaches the attached client once", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    let title: string | undefined;
    let notifyRosterChanged = (): void => undefined;
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SESSION_TITLE],
        findAgent: () => agent,
        listBackgroundAgents: () => roster(title),
        onRosterChanged: (listener) => {
            notifyRosterChanged = listener;
            return () => undefined;
        },
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SESSION_TITLE],
    });
    const titles: (string | undefined)[] = [];
    client.onSessionTitle((next) => titles.push(next));
    try {
        // The first report rides behind the attach reply, usually before a
        // listener can subscribe, so unchanged rosters must add nothing after it.
        await Bun.sleep(30);
        notifyRosterChanged();
        await Bun.sleep(30);
        expect(titles).toStrictEqual([]);
        expect(client.sessionTitle).toBeUndefined();

        title = "Plunder the crow's nest";
        notifyRosterChanged();
        notifyRosterChanged();
        await Bun.sleep(30);
        expect(titles).toStrictEqual(["Plunder the crow's nest"]);
        expect(client.sessionTitle).toBe("Plunder the crow's nest");
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

networked("a client that did not ask is never sent a title", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    let notifyRosterChanged = (): void => undefined;
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SESSION_TITLE],
        findAgent: () => agent,
        listBackgroundAgents: () => roster("Plunder the crow's nest"),
        onRosterChanged: (listener) => {
            notifyRosterChanged = listener;
            return () => undefined;
        },
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [],
    });
    const titles: (string | undefined)[] = [];
    client.onSessionTitle((next) => titles.push(next));
    try {
        notifyRosterChanged();
        await Bun.sleep(50);
        expect(titles).toStrictEqual([]);
        expect(client.closed).toBe(false);
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

networked("a title that exists at attach is reported behind the attach reply", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SESSION_TITLE],
        findAgent: () => agent,
        listBackgroundAgents: () => roster("Chart the reef"),
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SESSION_TITLE],
    });
    try {
        await Bun.sleep(30);
        expect(client.sessionTitle).toBe("Chart the reef");
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});
