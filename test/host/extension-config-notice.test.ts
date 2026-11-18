import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsumerRegistry } from "../../src/host/consumers.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { parseAgentUpdateFrame } from "../../src/host/agent-update-wire.ts";
import { HOST_CAPABILITY_AGENT_ATTACH_RESUME } from "../../src/host/capabilities.ts";
import { EXTENSION_CONFIG_NOTICE_KEY, activeExtensionConfigWatches } from "../../src/host/extension-config-watch.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { startSessionHost } from "../../src/host/session-host.ts";
import { StartupFindings } from "../../src/host/startup-findings.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { Inbox } from "../../src/store/inbox.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

const baseConfig = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "auto",
    disabled_included_extensions: [] as readonly string[],
} as const;

type TestConfig = typeof baseConfig;

async function openSessionHost(
    home: string,
    currentConfig: () => TestConfig,
) {
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(createConsumerRegistry(inbox));
    try {
        const host = await startSessionHost({
            sessions: "all",
            config: baseConfig,
            currentConfig,
            currentReachability: () => () => true,
            home,
            configPath: join(home, "config.json"),
            cacheDirectory: join(home, "catalog"),
            sessionDirectory: join(home, "sessions"),
            sessionIdentityReservationRoot: home,
            blockedDirectory: join(home, "blocked"),
            modelFailureLedgerPath: join(home, "failures.jsonl"),
            authStorage: createAuthStorage({ path: join(home, "auth.json") }),
            createAdapter: () => new FauxAdapter([]),
            hostLog: () => {},
            startupLog: () => {},
            startupFindings: new StartupFindings(),
            timed: async (_phase, run) => await run(),
            createServices: () => ({ models: {}, inboxDelivery: delivery }),
            turnsHeld: () => false,
            inboxActorForSession: () => null,
            annexUrl: () => undefined,
            forgetRestartRecords: () => {},
            recentScheduleRuns: () => [],
            onWorkChanged: () => () => {},
        });
        host.startStorage();
        return {
            host,
            async close() {
                try {
                    await host.close();
                } finally {
                    delivery.close();
                    inbox.close();
                }
            },
        };
    } catch (error) {
        delivery.close();
        inbox.close();
        throw error;
    }
}

test("a config edit reaches an attached session and names the host restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-ext-config-"));
    let config: TestConfig = baseConfig;
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, () => config);
        const agent = await opened.host.handlers.createAgent({ workspace: home });
        const attachment = await agent.attach();
        const toolsBefore = opened.host.registry.agents.get(agent.id)?.loopServices?.extensionTools;
        try {
            await Bun.sleep(100);
            config = { ...baseConfig, disabled_included_extensions: ["vera.mcp"] };
            await writeFile(join(home, "config.json"), JSON.stringify(config));
            const notice = await waitForNotice(attachment);
            expect(notice.text).toBe(
                "Disabled vera.mcp. Use Reconnect host (Ctrl+P) to unload it.",
            );
            // The running session keeps its tool list; only a host restart rebuilds it.
            expect(opened.host.registry.agents.get(agent.id)?.loopServices?.extensionTools)
                .toBe(toolsBefore);
        } finally {
            attachment.detach();
        }
    } finally {
        await opened?.close();
        expect(activeExtensionConfigWatches()).toBe(0);
        await rm(home, { recursive: true, force: true });
    }
});

test("a session attaches after the edit and still sees the drift", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-ext-config-"));
    let config: TestConfig = baseConfig;
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, () => config);
        const agent = await opened.host.handlers.createAgent({ workspace: home });
        await Bun.sleep(100);
        config = { ...baseConfig, disabled_included_extensions: ["vera.mcp"] };
        await writeFile(join(home, "config.json"), JSON.stringify(config));
        await Bun.sleep(1_200);
        const attachment = await agent.attach();
        try {
            const notice = await waitForNotice(attachment);
            expect(notice.text).toBe(
                "Disabled vera.mcp. Use Reconnect host (Ctrl+P) to unload it.",
            );
        } finally {
            attachment.detach();
        }
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});

test("@core extension config notices from the registry pass the client parser", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-ext-config-"));
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home, () => baseConfig);
        const agent = await opened.host.handlers.createAgent({ workspace: home });
        const attachment = await agent.attach();
        try {
            await opened.host.registry.agents.get(agent.id)!.loopReady;
            for (const operation of ["enable", "disable", "update"] as const) {
                opened.host.registry.publishExtensionConfigChanges([{ operation, id: "acme.crow", needsRestart: true }]);
                const notice = await waitForNotice(attachment);
                expect(notice.key).toBe(EXTENSION_CONFIG_NOTICE_KEY);
                expect(notice.count).toBe(1);
                expect(notice.facts).toBeUndefined();
                expect(notice.source).toBeUndefined();
                expect(parseAgentUpdateFrame(notice)).toEqual({ kind: "update", update: notice });
                expect(parseAgentUpdateFrame({ ...notice, facts: { operation } })).toEqual({ kind: "invalid_notice", seq: notice.seq });
            }
        } finally {
            attachment.detach();
        }
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});

socketTest("@core config changes leave current and newly attached socket clients connected", async () => {
    const home = await mkdtemp(join(tmpdir(), "ve-notice-"));
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let first: AttachedAgentClient | undefined;
    let second: AttachedAgentClient | undefined;
    try {
        await writeFile(join(home, "config.json"), JSON.stringify(baseConfig));
        host = await startResidentHost({
            home,
            config: baseConfig,
            processWorker: false,
            createAdapter: () => new FauxAdapter([]),
        });
        const agent = await host.registry.create({ id: "crow", workspace: home });
        first = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await first.receive(AbortSignal.timeout(5_000))).type).toBe("history");
        await host.registry.agents.get(agent.id)!.loopReady;
        await writeFile(join(home, "config.json"), JSON.stringify({
            ...baseConfig, disabled_included_extensions: ["vera.mcp"],
        }));
        const expected = "Disabled vera.mcp. Use Reconnect host (Ctrl+P) to unload it.";
        expect((await receiveSocketNotice(first)).text).toBe(expected);
        await checkSocketClient(first, "first");
        second = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await receiveSocketNotice(second)).text).toBe(expected);
        await checkSocketClient(second, "second");
        await checkSocketClient(first, "first-again");
    } finally {
        first?.close();
        second?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        expect(activeExtensionConfigWatches()).toBe(0);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

socketTest("@core repeated attaches suppress an identical notice in the resident replay window", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-ext-replay-"));
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let first: AttachedAgentClient | undefined;
    const clients: AttachedAgentClient[] = [];
    const eventLogPath = join(home, "events", "crow.jsonl");
    try {
        await writeFile(join(home, "config.json"), JSON.stringify(baseConfig));
        host = await startResidentHost({
            home,
            config: baseConfig,
            processWorker: false,
            createAdapter: () => new FauxAdapter([]),
            eventLogDirectory: join(home, "events"),
        });
        const agent = await host.registry.create({ id: "crow", workspace: home });
        first = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await first.receive(AbortSignal.timeout(5_000))).type).toBe("history");
        await host.registry.agents.get(agent.id)!.loopReady;
        await writeFile(join(home, "config.json"), JSON.stringify({
            ...baseConfig, disabled_included_extensions: ["vera.mcp"],
        }));
        const expected = "Disabled vera.mcp. Use Reconnect host (Ctrl+P) to unload it.";
        const original = await receiveSocketNotice(first);
        expect(original.text).toBe(expected);
        await waitForEventLines(eventLogPath, 1);

        for (let index = 0; index < 8; index += 1) {
            const client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
            clients.push(client);
            expect((await client.receive(AbortSignal.timeout(5_000))).type).toBe("history");
            expect((await receiveSocketNotice(client)).seq).toBe(original.seq);
            await expectNoSocketNotice(client);
            expect(await extensionNoticeLineCount(eventLogPath)).toBe(1);
        }

        const resumed = await attachAgent({
            socketPath: host.server.socketPath,
            agentId: agent.id,
            afterSequence: original.seq,
            requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACH_RESUME],
        });
        clients.push(resumed);
        await expectNoSocketNotice(resumed);
        expect(await extensionNoticeLineCount(eventLogPath)).toBe(1);

        agent.engine.send({ type: "history", entries: [], seq: original.seq });
        const simultaneous = [agent.attach(), agent.attach(), agent.attach()];
        try {
            await waitForEventLines(eventLogPath, 2);
        } finally {
            for (const attachment of simultaneous) attachment.detach();
        }
        const afterCheckpoint = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        clients.push(afterCheckpoint);
        expect((await afterCheckpoint.receive(AbortSignal.timeout(5_000))).type).toBe("history");
        const renewed = await receiveSocketNotice(afterCheckpoint);
        expect(renewed.text).toBe(expected);
        expect(renewed.seq).toBe(original.seq + 1);
        await expectNoSocketNotice(afterCheckpoint);
        await waitForEventLines(eventLogPath, 2);
        expect((await receiveSocketNotice(first)).seq).toBe(renewed.seq);

        const replayAfterCheckpoint = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        clients.push(replayAfterCheckpoint);
        expect((await replayAfterCheckpoint.receive(AbortSignal.timeout(5_000))).type).toBe("history");
        expect((await receiveSocketNotice(replayAfterCheckpoint)).seq).toBe(renewed.seq);
        await expectNoSocketNotice(replayAfterCheckpoint);
        expect(await extensionNoticeLineCount(eventLogPath)).toBe(2);

        await writeFile(join(home, "config.json"), JSON.stringify(baseConfig));
        expect((await receiveSocketNotice(first)).text).toBe("Enabled vera.mcp.");
        await waitForEventLines(eventLogPath, 3);
        await writeFile(join(home, "config.json"), JSON.stringify({
            ...baseConfig, disabled_included_extensions: ["vera.mcp"],
        }));
        expect((await receiveSocketNotice(first)).text).toBe(expected);
        await waitForEventLines(eventLogPath, 4);
    } finally {
        first?.close();
        for (const client of clients) client.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        expect(activeExtensionConfigWatches()).toBe(0);
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

async function extensionNoticeLineCount(path: string): Promise<number> {
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    return lines.filter((line) => {
        if (line.length === 0) return false;
        const event = JSON.parse(line) as { readonly type?: string; readonly key?: string };
        return event.type === "notice" && event.key === EXTENSION_CONFIG_NOTICE_KEY;
    }).length;
}

async function waitForEventLines(path: string, expected: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 2_000) {
        if (await extensionNoticeLineCount(path) === expected) return;
        await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${expected} extension notice event lines`);
}

async function expectNoSocketNotice(client: AttachedAgentClient): Promise<void> {
    const deadline = Date.now() + 100;
    while (Date.now() < deadline) {
        try {
            const update = await client.receive(AbortSignal.timeout(Math.max(0, deadline - Date.now())));
            if (update.type === "notice" && update.key === EXTENSION_CONFIG_NOTICE_KEY) {
                throw new Error("received a duplicate extension config notice");
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") return;
            throw error;
        }
    }
}

async function receiveSocketNotice(client: AttachedAgentClient): Promise<ExtensionNoticeUpdate> {
    const signal = AbortSignal.timeout(5_000);
    while (true) {
        const update = await client.receive(signal);
        if (update.type === "notice" && update.key === EXTENSION_CONFIG_NOTICE_KEY) return update;
    }
}

async function checkSocketClient(client: AttachedAgentClient, requestId: string): Promise<void> {
    await client.send({ type: "get_model_settings", requestId });
    const signal = AbortSignal.timeout(5_000);
    while (true) {
        const update = await client.receive(signal);
        if ((update.type === "model_settings" || update.type === "model_settings_rejected")
            && update.requestId === requestId) break;
    }
    expect(client.closed).toBe(false);
}

type ExtensionNoticeUpdate = Extract<AgentUpdate, { type: "notice" }>;

async function waitForNotice(
    attachment: AgentAttachment,
    timeoutMs = 2_000,
): Promise<ExtensionNoticeUpdate> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const pending = await attachment.receivePending();
        for (let update = pending.take(); update !== undefined; update = pending.take()) {
            if (update.type === "notice" && update.key === EXTENSION_CONFIG_NOTICE_KEY) {
                return update;
            }
        }
        await Bun.sleep(20);
    }
    throw new Error("timed out waiting for the extension config notice");
}
