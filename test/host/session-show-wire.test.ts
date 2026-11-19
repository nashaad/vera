import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findShowTarget } from "../../src/help/show-targets.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import {
    CLIENT_CAPABILITIES,
    HOST_CAPABILITY_SESSION_SHOW_TERMINAL,
    HOST_CAPABILITY_SESSION_SHOW_WINDOW,
} from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { createSessionShowHub } from "../../src/host/session-show.ts";
import { socketTest } from "../support/socket-probe.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-show-"));
    temporaryDirectories.push(directory);
    return directory;
}

function target(id: string) {
    const found = findShowTarget(id);
    if (found === undefined) throw new Error(`Unknown show target ${id}`);
    return found;
}

socketTest("a show request reaches the window and the terminal that asked, as an id", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const hub = createSessionShowHub();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SESSION_SHOW_WINDOW, HOST_CAPABILITY_SESSION_SHOW_TERMINAL],
        findAgent: () => agent,
        subscribeSessionShow: hub.subscribe,
    });
    const windowClient = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SESSION_SHOW_WINDOW],
    });
    const terminalClient = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SESSION_SHOW_TERMINAL],
    });
    const idle = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [],
    });
    const windowTargets: string[] = [];
    const terminalTargets: string[] = [];
    const idleTargets: string[] = [];
    windowClient.onSessionShow((next) => windowTargets.push(next));
    terminalClient.onSessionShow((next) => terminalTargets.push(next));
    idle.onSessionShow((next) => idleTargets.push(next));
    try {
        expect(hub.show(agent.id, target("dialog.themes"))).toStrictEqual({
            window: 1,
            terminal: 1,
            terminalCannot: 0,
        });
        expect(hub.show(agent.id, target("dialog.doctor"))).toStrictEqual({
            window: 1,
            terminal: 0,
            terminalCannot: 1,
        });
        await Bun.sleep(50);
        expect(windowTargets).toStrictEqual(["dialog.themes", "dialog.doctor"]);
        expect(terminalTargets).toStrictEqual(["dialog.themes"]);
        expect(idleTargets).toStrictEqual([]);
        expect(windowClient.closed).toBe(false);
    } finally {
        windowClient.close();
        terminalClient.close();
        idle.close();
        agent.close();
        await server.close();
    }
});

socketTest("a closed attachment stops hearing show requests", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const hub = createSessionShowHub();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SESSION_SHOW_WINDOW],
        findAgent: () => agent,
        subscribeSessionShow: hub.subscribe,
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SESSION_SHOW_WINDOW],
    });
    try {
        expect(hub.show(agent.id, target("dialog.themes")).window).toBe(1);
        client.close();
        await Bun.sleep(50);
        expect(hub.show(agent.id, target("dialog.themes"))).toStrictEqual({
            window: 0,
            terminal: 0,
            terminalCannot: 0,
        });
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

socketTest("a show request for another session is not sent", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const hub = createSessionShowHub();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_SESSION_SHOW_WINDOW],
        findAgent: () => agent,
        subscribeSessionShow: hub.subscribe,
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_SESSION_SHOW_WINDOW],
    });
    const targets: string[] = [];
    client.onSessionShow((next) => targets.push(next));
    try {
        expect(hub.show("agent-2", target("dialog.themes")).window).toBe(0);
        await Bun.sleep(30);
        expect(targets).toStrictEqual([]);
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

test("@core the default client capabilities never ask for a show request", () => {
    expect(CLIENT_CAPABILITIES).not.toContain(HOST_CAPABILITY_SESSION_SHOW_WINDOW);
    expect(CLIENT_CAPABILITIES).not.toContain(HOST_CAPABILITY_SESSION_SHOW_TERMINAL);
});
