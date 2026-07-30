import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { Inbox, type InboxEntryInput } from "../../src/store/inbox.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    InboxSpawnController,
    MAX_HELD_ENTRIES,
    SpawnConsentStore,
    SPAWN_CONSUMER_LABEL,
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
    const path = mkdtempSync(join(tmpdir(), "vera-spawn-hard-"));
    temporaries.push(path);
    return path;
}

class FakeHost {
    readonly requests: SpawnRequest[] = [];
    target = true;

    spawn = (request: SpawnRequest): Promise<SpawnedSession | null> => {
        this.requests.push(request);
        if (!this.target) {
            return Promise.resolve(null);
        }
        return Promise.resolve({
            label: request.address,
            recordProvenance: () => Promise.resolve(),
        });
    };
}

function harness(overrides: Partial<InboxSpawnOptions> = {}) {
    const inbox = Inbox.open(":memory:");
    const consumers = new ConsumerRegistry(inbox, "node-a");
    const host = new FakeHost();
    let now = 1_000;
    const controller = new InboxSpawnController({
        inbox,
        consumers,
        spawnSession: host.spawn,
        consent: { confirmed: true },
        subsystemEnabled: true,
        now: () => now,
        ...overrides,
    });
    return {
        inbox,
        consumers,
        host,
        controller,
        append: (entry: Partial<InboxEntryInput> = {}) => {
            inbox.append({
                source: "arc",
                kind: "post",
                payload: "{}",
                ...entry,
            });
        },
        offset: () =>
            inbox.offsetOf({ nodeId: "node-a", label: SPAWN_CONSUMER_LABEL }),
        setNow: (ms: number) => {
            now = ms;
        },
    };
}

describe("spawn controller hardening", () => {
    test("an entry scanned while consent is off is spawned once consent arrives", async () => {
        const consent = { confirmed: false };
        const h = harness({ consent });
        h.append({ address: "dormant" });

        await h.controller.scan();

        expect(h.host.requests).toHaveLength(0);
        expect(h.offset()).toBe(0);

        consent.confirmed = true;
        await h.controller.scan();

        expect(h.host.requests).toHaveLength(1);
        expect(h.offset()).toBe(1);
    });

    test("a gap record addressed to a dormant label never spawns", async () => {
        const h = harness();
        h.append({ kind: "source.gap", address: "dormant" });

        await h.controller.scan();

        expect(h.host.requests).toHaveLength(0);
        expect(h.offset()).toBe(1);
        h.inbox.close();
    });

    test("a rate-limited entry leaves the offset behind it", async () => {
        const h = harness({ minSpawnIntervalMs: 60_000 });
        h.append({ address: "noisy" });
        await h.controller.scan();
        expect(h.offset()).toBe(1);

        h.setNow(2_000);
        h.append({ address: "noisy" });
        await h.controller.scan();

        expect(h.offset()).toBe(1);
        expect(h.host.requests).toHaveLength(1);

        h.setNow(100_000);
        await h.controller.scan();

        expect(h.host.requests).toHaveLength(2);
        expect(h.offset()).toBe(2);
    });

    test("a rate-limited hold rescans itself when the cooldown expires", async () => {
        const timers: { run: () => void; ms: number }[] = [];
        const h = harness({
            minSpawnIntervalMs: 60_000,
            setTimer: (run, ms) => {
                timers.push({ run, ms });
                return timers.length - 1;
            },
            clearTimer: () => {},
        });
        h.append({ address: "noisy" });
        await h.controller.scan();
        h.setNow(2_000);
        h.append({ address: "noisy" });
        await h.controller.scan();

        expect(h.host.requests).toHaveLength(1);
        expect(timers).toHaveLength(1);
        expect(timers[0]!.ms).toBe(59_000);

        h.setNow(61_000);
        timers[0]!.run();
        await h.controller.scan();

        expect(h.host.requests).toHaveLength(2);
        expect(h.offset()).toBe(2);
    });

    test("a rescan does not inflate the coalesced count", async () => {
        const h = harness({ minSpawnIntervalMs: 60_000 });
        h.append({ address: "noisy" });
        await h.controller.scan();
        h.setNow(2_000);
        h.append({ address: "noisy" });
        await h.controller.scan();
        await h.controller.scan();
        h.setNow(100_000);
        await h.controller.scan();

        expect(h.host.requests[1]!.coalesced).toBe(1);
    });

    test("a held entry does not block a later spawnable one forever", async () => {
        const consent = { confirmed: false };
        const h = harness({ consent });
        h.append({ address: "waiting" });
        h.append({ address: "also-waiting" });
        await h.controller.scan();

        expect(h.offset()).toBe(0);

        consent.confirmed = true;
        await h.controller.scan();

        expect(h.host.requests.map((request) => request.address))
            .toEqual(["waiting", "also-waiting"]);
        expect(h.offset()).toBe(2);
    });

    test("held entries are capped and the loss is countable", async () => {
        const h = harness({
            consent: { confirmed: false },
            maxEntriesPerScan: MAX_HELD_ENTRIES + 10,
        });
        for (let index = 0; index < MAX_HELD_ENTRIES + 10; index += 1) {
            h.append({ address: `address-${index}` });
        }
        await h.controller.scan();

        expect(h.controller.held().length).toBe(MAX_HELD_ENTRIES);
        expect(h.controller.heldDroppedCount()).toBe(10);
    });

    test("the subsystem flag is required rather than assumed on", async () => {
        const h = harness({ subsystemEnabled: false });
        h.append({ address: "dormant" });
        await h.controller.scan();

        expect(h.controller.enabled).toBe(false);
        expect(h.controller.held()[0]!.reason).toBe("subsystem-off");
        expect(h.host.requests).toHaveLength(0);
    });
});

describe("spawn consent file", () => {
    test("only the full confirmed_at shape is consent", () => {
        const directory = temporaryDirectory();
        const path = join(directory, "spawn-consent.json");

        writeFileSync(path, "yes");
        expect(SpawnConsentStore.open(path).confirmed).toBe(false);

        writeFileSync(path, JSON.stringify({ spawn_on_event: "yes" }));
        expect(SpawnConsentStore.open(path).confirmed).toBe(false);

        writeFileSync(path, JSON.stringify({ spawn_on_event: {} }));
        expect(SpawnConsentStore.open(path).confirmed).toBe(false);

        writeFileSync(
            path,
            JSON.stringify({ spawn_on_event: { confirmed_at: "not a date" } }),
        );
        expect(SpawnConsentStore.open(path).confirmed).toBe(false);

        writeFileSync(
            path,
            JSON.stringify({
                spawn_on_event: { confirmed_at: "2026-07-28T00:00:00.000Z" },
            }),
        );
        expect(SpawnConsentStore.open(path).confirmed).toBe(true);
    });

    test("deleting the file withdraws consent without a restart", () => {
        const directory = temporaryDirectory();
        const path = join(directory, "spawn-consent.json");
        const store = SpawnConsentStore.open(path);
        store.confirm("2026-07-28T00:00:00.000Z");

        expect(store.confirmed).toBe(true);

        rmSync(path);

        expect(store.confirmed).toBe(false);
    });

    test("what confirm writes is what open reads back", () => {
        const directory = temporaryDirectory();
        const path = join(directory, "spawn-consent.json");
        SpawnConsentStore.open(path).confirm("2026-07-28T01:02:03.000Z");

        const reopened = SpawnConsentStore.open(path);

        expect(reopened.confirmed).toBe(true);
        expect(reopened.confirmedAtIso).toBe("2026-07-28T01:02:03.000Z");
    });
});
