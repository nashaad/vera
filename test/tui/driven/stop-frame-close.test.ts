import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../../src/host/attached-client.ts";
import { NO_BACKGROUND_AGENTS } from "../../../src/host/background-agents.ts";
import { createReconnectingAgentClient } from "../../../src/host/reconnecting-agent-client.ts";
import { socketTest } from "../../support/socket-probe.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

socketTest("a stopped frame immediately before close prevents automatic host restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-stop-frame-"));
    const socketPath = join(root, "host.sock");
    let peer: Socket | undefined;
    const server = createServer((socket) => {
        peer = socket;
        socket.once("data", () => {
            socket.write(`${JSON.stringify({
                type: "attached",
                agent_id: "crow-session",
                workspace: "/tmp",
                background_agents: NO_BACKGROUND_AGENTS,
            })}\n${JSON.stringify({
                type: "history", entries: [{ kind: "assistant", text: "First crow voyage" }], seq: 0,
            })}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    const attached = await attachAgent({ socketPath, agentId: "crow-session", maxPendingUpdates: 1 });
    const client = createReconnectingAgentClient(attached, async () => {
        throw new Error("unexpected reattach");
    }, { failOnDisconnect: true });
    let starts = 0;
    const session = await startTuiTestSession({
        home: root,
        waitTimeoutMs: 2_000,
        dependencies: () => ({
            client: { ...client, listExtensionCommands: async () => [] },
            reconnectSession: async () => { starts += 1; return client; },
        }),
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        const statuses = Array.from({ length: 64 }, (_, index) =>
            JSON.stringify({ type: "status", state: "idle", seq: index + 1 })).join("\n");
        peer!.write(`${statuses}\n${JSON.stringify({ type: "host_stop_wait_cleared", reason: "stopped" })}\n`);
        peer!.destroy();
        await session.waitForVisiblePane("The host stopped.");
        await session.settle(300);
        expect(starts).toBe(0);
    } finally {
        await session.close();
        peer?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
}, 15_000);

socketTest("a received stopped frame wins over a simultaneous failed send", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-stop-race-"));
    const socketPath = join(root, "host.sock");
    let peer: Socket | undefined;
    const server = createServer((socket) => {
        peer = socket;
        socket.once("data", () => {
            socket.write(`${JSON.stringify({
                type: "attached",
                agent_id: "crow-session",
                workspace: "/tmp",
                background_agents: NO_BACKGROUND_AGENTS,
            })}\n${JSON.stringify({
                type: "history", entries: [{ kind: "assistant", text: "First crow voyage" }], seq: 0,
            })}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    const attached = await attachAgent({ socketPath, agentId: "crow-session", maxPendingUpdates: 1 });
    const client = createReconnectingAgentClient(attached, async () => {
        throw new Error("unexpected reattach");
    }, { failOnDisconnect: true });
    const pendingSends: Array<(error: Error) => void> = [];
    const wrapped = {
        ...client,
        listExtensionCommands: async () => [],
        send(command: Parameters<typeof client.send>[0]) {
            if (command.type !== "get_model_settings") return client.send(command);
            return new Promise<void>((_resolve, reject) => { pendingSends.push(reject); });
        },
    };
    let starts = 0;
    const session = await startTuiTestSession({
        home: root,
        waitTimeoutMs: 2_000,
        dependencies: () => ({
            client: wrapped,
            reconnectSession: async () => { starts += 1; return wrapped; },
        }),
    });
    const emit = Socket.prototype.emit;
    let receivedFrame = false;
    try {
        await session.waitForVisiblePane("First crow voyage");
        expect(pendingSends.length).toBeGreaterThan(0);
        Socket.prototype.emit = function (this: Socket, event: string | symbol, ...args: unknown[]): boolean {
            if (!receivedFrame && event === "data" && Buffer.isBuffer(args[0])
                && args[0].includes('"host_stop_wait_cleared"')) {
                receivedFrame = true;
                for (const reject of pendingSends.splice(0)) reject(new Error("host connection closed"));
            }
            return Reflect.apply(emit, this, [event, ...args]);
        } as typeof Socket.prototype.emit;
        const statuses = Array.from({ length: 64 }, (_, index) =>
            JSON.stringify({ type: "status", state: "idle", seq: index + 1 })).join("\n");
        peer!.end(`${statuses}\n${JSON.stringify({ type: "host_stop_wait_cleared", reason: "stopped" })}\n`);
        await session.waitForVisiblePane("The host stopped.");
        await session.settle(300);
        expect(receivedFrame).toBe(true);
        expect(starts).toBe(0);
    } finally {
        Socket.prototype.emit = emit;
        await session.close();
        peer?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
}, 15_000);

socketTest("a buffered stopped frame survives a simultaneous socket error", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-stop-error-"));
    const socketPath = join(root, "host.sock");
    let peer: Socket | undefined;
    const server = createServer((socket) => {
        peer = socket;
        socket.once("data", () => {
            socket.write(`${JSON.stringify({
                type: "attached",
                agent_id: "crow-session",
                workspace: "/tmp",
                background_agents: NO_BACKGROUND_AGENTS,
            })}\n${JSON.stringify({
                type: "history", entries: [{ kind: "assistant", text: "First crow voyage" }], seq: 0,
            })}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    const attached = await attachAgent({ socketPath, agentId: "crow-session", maxPendingUpdates: 1 });
    const client = createReconnectingAgentClient(attached, async () => {
        throw new Error("unexpected reattach");
    }, { failOnDisconnect: true });
    let starts = 0;
    const session = await startTuiTestSession({
        home: root,
        waitTimeoutMs: 2_000,
        dependencies: () => ({
            client: { ...client, listExtensionCommands: async () => [] },
            reconnectSession: async () => { starts += 1; return client; },
        }),
    });
    const emit = Socket.prototype.emit;
    let receivedFrame = false;
    try {
        await session.waitForVisiblePane("First crow voyage");
        Socket.prototype.emit = function (this: Socket, event: string | symbol, ...args: unknown[]): boolean {
            if (!receivedFrame && event === "data" && Buffer.isBuffer(args[0])
                && args[0].includes('"host_stop_wait_cleared"')) {
                receivedFrame = true;
                const result = Reflect.apply(emit, this, [event, ...args]);
                const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
                Reflect.apply(emit, this, ["error", error]);
                return result;
            }
            return Reflect.apply(emit, this, [event, ...args]);
        } as typeof Socket.prototype.emit;
        const statuses = Array.from({ length: 64 }, (_, index) =>
            JSON.stringify({ type: "status", state: "idle", seq: index + 1 })).join("\n");
        peer!.end(`${statuses}\n${JSON.stringify({ type: "host_stop_wait_cleared", reason: "stopped" })}\n`);
        await session.waitForVisiblePane("The host stopped.");
        await session.settle(300);
        expect(receivedFrame).toBe(true);
        expect(starts).toBe(0);
    } finally {
        Socket.prototype.emit = emit;
        await session.close();
        peer?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
}, 15_000);
