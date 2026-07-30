import { describe, expect, test } from "bun:test";

import {
    ConsumerRegistry,
    createConsumerRegistry,
    DEFAULT_MIN_WAKE_INTERVAL_MS,
} from "../../src/host/consumers.ts";
import { Inbox, openInboxIfEnabled } from "../../src/store/inbox.ts";

function fixture(): { inbox: Inbox; registry: ConsumerRegistry } {
    const inbox = Inbox.open(":memory:");
    return { inbox, registry: new ConsumerRegistry(inbox, "node-a") };
}

function entry(kind: string, extra: { actor?: string; session?: string; address?: string } = {}) {
    return {
        source: "test",
        kind,
        actor: extra.actor ?? null,
        session: extra.session ?? null,
        address: extra.address ?? null,
        payload: "{}",
    };
}

describe("consumer handles", () => {
    test("two live sessions asking for one label get distinct ids", () => {
        const { inbox, registry } = fixture();
        const first = registry.hello({ label: "reviewer" });
        const second = registry.hello({ label: "reviewer" });

        expect(first.id).toEqual({ nodeId: "node-a", label: "reviewer" });
        expect(second.id).toEqual({ nodeId: "node-a", label: "reviewer-2" });
        expect(inbox.offsetOf(first.id)).toBe(0);
        expect(inbox.offsetOf(second.id)).toBe(0);
        inbox.close();
    });

    test("a released label reclaims its durable offset on the next hello", () => {
        const { inbox, registry } = fixture();
        const first = registry.hello({ label: "reviewer" });
        inbox.appendAll([entry("a"), entry("b")]);
        first.advance(1);
        first.release();
        inbox.appendAll([entry("c")]);

        const returning = registry.hello({ label: "reviewer" });
        expect(returning.id.label).toBe("reviewer");
        expect(returning.offset()).toBe(1);
        expect(returning.read({ limit: 10 }).map((row) => row.kind))
            .toEqual(["b", "c"]);
        inbox.close();
    });

    test("a brand new consumer starts at the tail", () => {
        const { inbox, registry } = fixture();
        inbox.appendAll([entry("a"), entry("b")]);
        const handle = registry.hello({ label: "late" });

        expect(handle.offset()).toBe(2);
        expect(handle.read({ limit: 10 })).toEqual([]);
        inbox.close();
    });

    test("reads exclude the consumer's own self-echo pair", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({
            label: "worker",
            selfEcho: { actor: "worker", session: "s1" },
        });
        inbox.appendAll([
            entry("own", { actor: "worker", session: "s1" }),
            entry("other", { actor: "peer", session: "s2" }),
        ]);

        expect(handle.read({ limit: 10 }).map((row) => row.kind)).toEqual(["other"]);
        expect(
            handle.read({ limit: 10, excludeSelfEcho: false }).map((row) => row.kind),
        ).toEqual(["own", "other"]);
        inbox.close();
    });

    test("a consumer with no self-echo pair still sees unattributed entries", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({ label: "worker" });
        inbox.appendAll([entry("a"), entry("b", { actor: "peer" })]);

        expect(handle.read({ limit: 10 }).map((row) => row.kind)).toEqual(["a", "b"]);
        inbox.close();
    });

    test("addressed entries stay visible alongside unaddressed ones", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({ label: "worker" });
        inbox.appendAll([
            entry("broadcast"),
            entry("mine", { address: "worker" }),
            entry("theirs", { address: "other" }),
        ]);

        expect(
            handle.read({ limit: 10, addresses: ["worker"] }).map((row) => row.kind),
        ).toEqual(["broadcast", "mine"]);
        expect(handle.read({ limit: 10 }).map((row) => row.kind)).toEqual([
            "broadcast",
            "mine",
            "theirs",
        ]);
        inbox.close();
    });

    test("reading does not advance, advancing does", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({ label: "worker" });
        inbox.appendAll([entry("a"), entry("b")]);

        expect(handle.read({ limit: 10 })).toHaveLength(2);
        expect(handle.offset()).toBe(0);
        expect(handle.lag()).toBe(2);

        handle.advance(2);
        expect(handle.offset()).toBe(2);
        expect(handle.lag()).toBe(0);
        inbox.close();
    });

    test("the wake rate limit is a readable property of the handle", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({
            label: "worker",
            wake: { minWakeIntervalMs: 1000 },
        });

        expect(handle.wake.minWakeIntervalMs).toBe(1000);
        expect(handle.mayWake(0)).toBe(true);
        handle.recordWake(0);
        expect(handle.mayWake(500)).toBe(false);
        expect(handle.wakeCooldownMs(500)).toBe(500);
        expect(handle.mayWake(1000)).toBe(true);
        expect(handle.wakeCooldownMs(1000)).toBe(0);
        inbox.close();
    });

    test("a zero interval never rate limits, and the default is non-zero", () => {
        const { inbox, registry } = fixture();
        const open = registry.hello({ label: "open", wake: { minWakeIntervalMs: 0 } });
        open.recordWake(0);
        expect(open.mayWake(0)).toBe(true);

        const standard = registry.hello({ label: "standard" });
        expect(standard.wake.minWakeIntervalMs).toBe(DEFAULT_MIN_WAKE_INTERVAL_MS);
        inbox.close();
    });

    test("consumers are enumerable live and dormant with offset and lag", () => {
        const { inbox, registry } = fixture();
        const live = registry.hello({ label: "live" });
        const dormant = registry.hello({ label: "dormant" });
        inbox.appendAll([entry("a"), entry("b"), entry("c")]);
        live.advance(1);
        dormant.release();

        const rows = registry.list();
        expect(rows.map((row) => row.label)).toEqual(["dormant", "live"]);
        expect(rows.find((row) => row.label === "live")).toMatchObject({
            live: true,
            seq: 1,
            lag: 2,
        });
        expect(rows.find((row) => row.label === "dormant")).toMatchObject({
            live: false,
            seq: 0,
            lag: 3,
        });
        inbox.close();
    });

    test("a released handle refuses to read or advance", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({ label: "worker" });
        handle.release();

        expect(handle.isLive).toBe(false);
        expect(registry.get("worker")).toBeUndefined();
        expect(() => handle.read({ limit: 1 })).toThrow("released inbox consumer");
        expect(() => handle.advance(1)).toThrow("released inbox consumer");
        inbox.close();
    });

    test("a consumer renders as its label and as nodeId/label", () => {
        const { inbox, registry } = fixture();
        const handle = registry.hello({ label: "reviewer" });

        expect(handle.label).toBe("reviewer");
        expect(handle.toString()).toBe("node-a/reviewer");
        inbox.close();
    });

    test("an empty label is refused", () => {
        const { inbox, registry } = fixture();
        expect(() => registry.hello({ label: "  " })).toThrow("cannot be empty");
        inbox.close();
    });

    test("no registry exists when the inbox feature is off", () => {
        expect(createConsumerRegistry(openInboxIfEnabled({}, ":memory:"))).toBeNull();

        const inbox = openInboxIfEnabled({ experimental: { inbox: true } }, ":memory:");
        const registry = createConsumerRegistry(inbox, "node-a");
        expect(registry).not.toBeNull();
        inbox?.close();
    });
});
