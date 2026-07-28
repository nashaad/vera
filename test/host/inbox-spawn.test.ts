import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { Inbox, type InboxEntryInput } from "../../src/store/inbox.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    COLD_SPAWN_APPROVAL_MODE,
    InboxSpawnController,
    SpawnConsentStore,
    spawnOnEventEnabled,
    type InboxSpawnOptions,
    type SpawnRequest,
    type SpawnedSession,
} from "../../src/host/inbox-spawn.ts";

const temporaries: string[] = [];

afterEach(() => {
    for (const path of temporaries.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-spawn-"));
    temporaries.push(path);
    return path;
}

class FakeHost {
    readonly requests: SpawnRequest[] = [];
    readonly provenance: string[] = [];
    target: boolean = true;

    spawn = (request: SpawnRequest): Promise<SpawnedSession | null> => {
        this.requests.push(request);
        if (!this.target) {
            return Promise.resolve(null);
        }
        return Promise.resolve({
            label: request.address,
            recordProvenance: (text: string) => {
                this.provenance.push(text);
                return Promise.resolve();
            },
        });
    };
}

interface Harness {
    readonly inbox: Inbox;
    readonly consumers: ConsumerRegistry;
    readonly host: FakeHost;
    readonly controller: InboxSpawnController;
    append(entry: Partial<InboxEntryInput>): void;
    setNow(ms: number): void;
}

function harness(overrides: Partial<InboxSpawnOptions> = {}): Harness {
    const inbox = Inbox.open(":memory:");
    const consumers = new ConsumerRegistry(inbox, "node-a");
    const host = new FakeHost();
    let now = 1_000;
    const controller = new InboxSpawnController({
        inbox,
        consumers,
        spawnSession: host.spawn,
        consent: { confirmed: true },
        now: () => now,
        ...overrides,
    });
    return {
        inbox,
        consumers,
        host,
        controller,
        append(entry) {
            inbox.append({
                source: "arc",
                kind: "issue.updated",
                payload: "{}",
                ...entry,
            });
        },
        setNow(ms) {
            now = ms;
        },
    };
}

describe("spawn gates", () => {
    test("both gates are required", () => {
        expect(spawnOnEventEnabled({
            subsystemEnabled: false,
            userConfirmed: false,
        })).toBe(false);
        expect(spawnOnEventEnabled({
            subsystemEnabled: true,
            userConfirmed: false,
        })).toBe(false);
        expect(spawnOnEventEnabled({
            subsystemEnabled: false,
            userConfirmed: true,
        })).toBe(false);
        expect(spawnOnEventEnabled({
            subsystemEnabled: true,
            userConfirmed: true,
        })).toBe(true);
    });

    test("a fresh install has not confirmed", () => {
        const store = SpawnConsentStore.open(
            join(temporaryDirectory(), "spawn-consent.json"),
        );
        expect(store.confirmed).toBe(false);
    });

    test("confirmation survives a reopen and revoke clears it", () => {
        const path = join(temporaryDirectory(), "spawn-consent.json");
        const store = SpawnConsentStore.open(path);
        store.confirm("2026-07-28T00:00:00.000Z");
        expect(SpawnConsentStore.open(path).confirmed).toBe(true);
        store.revoke();
        expect(SpawnConsentStore.open(path).confirmed).toBe(false);
    });

    test("a config-shaped file cannot stand in for confirmation", () => {
        const directory = temporaryDirectory();
        const path = join(directory, "spawn-consent.json");
        Bun.write(path, `{"experimental":{"spawn_on_event":true}}\n`);
        expect(SpawnConsentStore.open(path).confirmed).toBe(false);
    });
});

describe("spawn controller", () => {
    test("an unconfirmed toggle starts nothing and holds the entry", async () => {
        const h = harness({ consent: { confirmed: false } });
        h.append({ address: "dormant" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
        expect(h.controller.held()).toEqual([
            { address: "dormant", seq: 1, reason: "not-confirmed" },
        ]);
    });

    test("the subsystem gate is reported separately", async () => {
        const h = harness({
            consent: { confirmed: true },
            subsystemEnabled: false,
        });
        h.append({ address: "dormant" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
        expect(h.controller.held()[0]!.reason).toBe("subsystem-off");
    });

    test("a live consumer is woken by delivery, never spawned for", async () => {
        const h = harness();
        h.consumers.hello({ label: "live" });
        h.append({ address: "live" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
        expect(h.controller.held()).toHaveLength(0);
    });

    test("a dormant consumer spawns with provenance", async () => {
        const h = harness();
        h.append({ address: "dormant", source: "arc", kind: "issue.updated" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(1);
        const request = h.host.requests[0]!;
        expect(request.address).toBe("dormant");
        expect(request.entry.seq).toBe(1);
        expect(h.host.provenance[0]).toContain("inbox entry 1");
        expect(h.host.provenance[0]).toContain("arc/issue.updated");
        expect(h.host.provenance[0]).toContain("dormant");
    });

    test("a cold spawn asks for everything", async () => {
        const h = harness();
        h.append({ address: "dormant" });
        await h.controller.scan();
        expect(h.host.requests[0]!.approvalMode).toBe(COLD_SPAWN_APPROVAL_MODE);
    });

    test("a prior session's posture is inherited rather than escalated", async () => {
        const h = harness({
            inheritedApprovalMode: (address) =>
                address === "dormant" ? "auto" : undefined,
        });
        h.append({ address: "dormant" });
        h.append({ address: "other" });
        await h.controller.scan();
        const modes = h.host.requests.map((request) => request.approvalMode);
        expect(modes).toEqual(["auto", COLD_SPAWN_APPROVAL_MODE]);
    });

    test("an entry a session caused never spawns for that session", async () => {
        const h = harness();
        h.append({ address: "dormant", session: "dormant", actor: "agent" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
        expect(h.controller.held()[0]!.reason).toBe("self-caused");
    });

    test("an entry any known session caused never spawns", async () => {
        const h = harness({
            causedByKnownSession: (entry) => entry.session === "session-1",
        });
        h.append({ address: "dormant", session: "session-1" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
        expect(h.controller.held()[0]!.reason).toBe("self-caused");
    });

    test("a burst coalesces into one spawn", async () => {
        const h = harness();
        for (let index = 0; index < 5; index += 1) {
            h.append({ address: "dormant" });
        }
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(1);
        expect(h.host.requests[0]!.coalesced).toBe(5);
    });

    test("a second spawn inside the cap is held, not queued", async () => {
        const h = harness({ minSpawnIntervalMs: 60_000 });
        h.append({ address: "dormant" });
        await h.controller.scan();
        h.setNow(2_000);
        h.append({ address: "dormant" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(1);
        expect(h.controller.held()).toEqual([
            { address: "dormant", seq: 2, reason: "rate-limited" },
        ]);
    });

    test("held entries fold into one spawn once the cap clears", async () => {
        const h = harness({ minSpawnIntervalMs: 60_000 });
        h.append({ address: "dormant" });
        await h.controller.scan();
        h.setNow(2_000);
        h.append({ address: "dormant" });
        h.append({ address: "dormant" });
        await h.controller.scan();
        h.setNow(100_000);
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(2);
        expect(h.host.requests[1]!.coalesced).toBe(2);
    });

    test("one address over the cap does not block another", async () => {
        const h = harness({ minSpawnIntervalMs: 60_000 });
        h.append({ address: "noisy" });
        await h.controller.scan();
        h.setNow(2_000);
        h.append({ address: "noisy" });
        h.append({ address: "quiet" });
        await h.controller.scan();
        const addresses = h.host.requests.map((request) => request.address);
        expect(addresses).toEqual(["noisy", "quiet"]);
    });

    test("no target holds the entry instead of dropping it", async () => {
        const h = harness();
        h.host.target = false;
        h.append({ address: "dormant" });
        await h.controller.scan();
        expect(h.controller.held()[0]!.reason).toBe("no-target");
        h.host.target = true;
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(2);
    });

    test("an unaddressed entry spawns nothing", async () => {
        const h = harness();
        h.append({});
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
        expect(h.controller.held()).toHaveLength(0);
    });

    test("a released controller stops scanning", async () => {
        const h = harness();
        h.controller.release();
        h.append({ address: "dormant" });
        await h.controller.scan();
        expect(h.host.requests).toHaveLength(0);
    });
});
