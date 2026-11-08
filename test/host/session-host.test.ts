import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { startSessionHost } from "../../src/host/session-host.ts";
import { StartupFindings } from "../../src/host/startup-findings.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "auto",
} as const;

async function openSessionHost(home: string) {
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(createConsumerRegistry(inbox));
    try {
        const host = await startSessionHost({
            sessions: "all",
            config,
            currentConfig: () => config,
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

test("a session host persists and restores sessions without a public listener", async () => {
    const home = await mkdtemp(join(tmpdir(), "vera-session-host-"));
    let opened: Awaited<ReturnType<typeof openSessionHost>> | undefined;
    try {
        opened = await openSessionHost(home);
        const created = await opened.host.handlers.createAgent({ workspace: home });
        const id = created.id;
        expect(await opened.host.handlers.findAgent(id)).toBe(created);
        expect(await opened.host.handlers.closeAgent(id)).toEqual({
            status: "closed",
            sessionRetained: true,
        });
        expect(await opened.host.handlers.listAgents()).toEqual([
            expect.objectContaining({ id, live: false }),
        ]);
        await opened.close();
        opened = undefined;

        opened = await openSessionHost(home);
        expect(opened.host.registry.find(id)).toBeUndefined();
        expect(await opened.host.handlers.listAgents()).toEqual([
            expect.objectContaining({ id, live: false }),
        ]);
        const restored = await opened.host.handlers.findAgent(id);
        expect(restored?.id).toBe(id);
        expect(await opened.host.handlers.findAgent(id)).toBe(restored);
        expect(await opened.host.handlers.listAgents()).toEqual([
            expect.objectContaining({ id, live: true }),
        ]);
        expect(existsSync(join(home, "runtime", "host.sock"))).toBe(false);
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
    } finally {
        await opened?.close();
        await rm(home, { recursive: true, force: true });
    }
});
