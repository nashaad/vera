import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsumerRegistry } from "../../src/host/consumers.ts";
import { EXTENSION_CONFIG_NOTICE_KEY, activeExtensionConfigWatches } from "../../src/host/extension-config-watch.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { startSessionHost } from "../../src/host/session-host.ts";
import { StartupFindings } from "../../src/host/startup-findings.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { Inbox } from "../../src/store/inbox.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
            expect(notice.facts).toEqual({
                operation: "disable",
                id: "vera.mcp",
                needs_restart: true,
            });
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
