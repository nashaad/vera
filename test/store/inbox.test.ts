import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    Inbox,
    type ConsumerId,
    orderedReadQuery,
    type InboxEntryInput,
} from "../../src/store/inbox.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const watcher: ConsumerId = { nodeId: "node-a", label: "reviewer" };

test("append assigns increasing seq and returns the stored entry", () => {
    const inbox = Inbox.open(":memory:");
    const first = inbox.append(entry({ kind: "issue.claimed" }));
    const second = inbox.append(entry({ kind: "board.post" }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.source).toBe("arc");
    expect(first.payload).toBe('{"issue":"nash-91"}');
    expect(first.actor).toBe("nash");
    expect(first.session).toBe("opus-91");
    inbox.close();
});

test("producer appendOnce returns one durable entry across retries", () => {
    const inbox = Inbox.open(":memory:");
    const input = entry({ kind: "schedule.triggered" });
    const first = inbox.appendOnce("vera.scheduler", "daily/2026-08-10", input);
    const replay = inbox.appendOnce("vera.scheduler", "daily/2026-08-10", {
        ...input,
        payload: '{"different":"retry body is ignored"}',
    });

    expect(first).toMatchObject({ created: true, entry: { seq: 1 } });
    expect(replay).toEqual({ created: false, entry: first.entry });
    expect(inbox.tail()).toBe(1);
    inbox.close();
});

test("a new consumer starts at the tail and reads only later entries", () => {
    const inbox = Inbox.open(":memory:");
    inbox.append(entry({ kind: "old" }));
    inbox.append(entry({ kind: "older" }));

    expect(inbox.registerConsumer(watcher)).toBe(2);
    expect(inbox.read(watcher, { limit: 10 })).toEqual([]);

    const fresh = inbox.append(entry({ kind: "new" }));
    const seen = inbox.read(watcher, { limit: 10 });
    expect(seen.map((row) => row.seq)).toEqual([fresh.seq]);
    inbox.close();
});

test("reading does not advance the offset", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    inbox.append(entry({ kind: "one" }));

    expect(inbox.read(watcher, { limit: 10 }).length).toBe(1);
    expect(inbox.read(watcher, { limit: 10 }).length).toBe(1);
    expect(inbox.offsetOf(watcher)).toBe(0);

    inbox.advance(watcher, 1);
    expect(inbox.read(watcher, { limit: 10 })).toEqual([]);
    inbox.close();
});

test("reads honour the caller limit and stay in seq order", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    for (let index = 0; index < 5; index += 1) {
        inbox.append(entry({ kind: `k${index}` }));
    }

    const page = inbox.read(watcher, { limit: 2 });
    expect(page.map((row) => row.seq)).toEqual([1, 2]);
    inbox.advance(watcher, page[1]!.seq);
    expect(inbox.read(watcher, { limit: 2 }).map((row) => row.seq)).toEqual([3, 4]);
    inbox.close();
});

test("afterSeq narrows every read that accepts it, never below the consumer offset", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    for (let index = 0; index < 6; index += 1) {
        inbox.append(entry({ kind: `k${index}` }));
    }

    expect(inbox.read(watcher, { limit: 10, afterSeq: 3 }).map((row) => row.seq))
        .toEqual([4, 5, 6]);
    expect(inbox.readAfter(0, { limit: 10, afterSeq: 4 }).map((row) => row.seq))
        .toEqual([5, 6]);
    expect(inbox.unreadStats(watcher, { limit: 10, afterSeq: 4 })).toMatchObject({
        count: 2,
        newestSeq: 6,
    });

    inbox.advance(watcher, 5);
    expect(inbox.read(watcher, { limit: 10, afterSeq: 2 }).map((row) => row.seq))
        .toEqual([6]);
    inbox.close();
});

test("an ordered read merges one index search per address instead of scanning or sorting", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-inbox-plan-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "inbox.db");
    Inbox.open(path).close();

    const { sql, parameters } = orderedReadQuery(5, {
        limit: 99,
        addresses: ["reviewer", "builder"],
        excludeKinds: ["noise"],
        excludeOrigin: { actor: "nash", session: "opus-91" },
    });
    const database = new Database(path);
    const plan = database
        .query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...parameters)
        .map((row) => row.detail)
        .join("\n");
    database.close();

    // A seq scan or temp sort pays for every row after the cursor, including other conversations' rows.
    expect(plan).toContain("MERGE (UNION ALL)");
    expect(plan.match(/SEARCH entries USING INDEX entries_address \(address=\? AND seq>\?\)/g)).toHaveLength(3);
    expect(plan).not.toContain("SCAN");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).not.toContain("MULTI-INDEX OR");
});

test("an ordered read interleaves addresses and broadcasts in seq order and lists a repeated address once", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    inbox.appendAll([
        entry({ address: "reviewer" }),
        entry({ address: "other" }),
        entry({ address: null }),
        entry({ address: "builder" }),
        entry({ address: "reviewer" }),
    ]);

    const seqs = (addresses: readonly string[], limit: number): number[] =>
        inbox.read(watcher, { limit, addresses }).map((read) => read.seq);

    expect(seqs(["reviewer", "builder", "reviewer"], 99)).toEqual([1, 3, 4, 5]);
    expect(seqs(["reviewer", "builder"], 3)).toEqual([1, 3, 4]);
    expect(seqs([], 99)).toEqual([3]);
    expect(inbox.read(watcher, { limit: 99 }).map((read) => read.seq)).toEqual([1, 2, 3, 4, 5]);
    inbox.close();
});

test("offsets never move backwards", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    inbox.appendAll([entry({ kind: "a" }), entry({ kind: "b" }), entry({ kind: "c" })]);

    inbox.advance(watcher, 3);
    expect(inbox.advance(watcher, 1)).toBe(3);
    inbox.close();
});

test("acknowledgement advances the offset idempotently and appends nothing", () => {
    const inbox = Inbox.open(":memory:");
    const consumer = { nodeId: "node-a", label: "right" };
    inbox.registerConsumer(consumer);
    const message = inbox.append({
        source: "vera",
        kind: "peer.message",
        actor: "left",
        session: "left",
        address: "right",
        payload: "{}",
    });

    expect(inbox.acknowledge(consumer, message.seq)).toEqual({ offset: message.seq });
    expect(inbox.acknowledge(consumer, message.seq)).toEqual({ offset: message.seq });
    expect(inbox.tail()).toBe(message.seq);
    inbox.close();
});

test("offsets are durable per node and label across restarts", () => {
    const path = join(temporaryDirectory(), "inbox", "inbox.db");
    const first = Inbox.open(path);
    first.registerConsumer(watcher);
    first.appendAll([entry({ kind: "a" }), entry({ kind: "b" })]);
    first.advance(watcher, 1);
    first.close();

    const second = Inbox.open(path);
    expect(second.offsetOf(watcher)).toBe(1);
    expect(second.read(watcher, { limit: 10 }).map((row) => row.seq)).toEqual([2]);
    second.close();
});

test("a returning consumer resumes its old offset instead of the tail", () => {
    const path = join(temporaryDirectory(), "inbox.db");
    const first = Inbox.open(path);
    first.registerConsumer(watcher);
    first.append(entry({ kind: "missed" }));
    first.close();

    const second = Inbox.open(path);
    second.append(entry({ kind: "also missed" }));
    expect(second.registerConsumer(watcher)).toBe(0);
    expect(second.read(watcher, { limit: 10 }).map((row) => row.kind)).toEqual([
        "missed",
        "also missed",
    ]);
    second.close();
});

test("the same label on a different node is a different consumer", () => {
    const inbox = Inbox.open(":memory:");
    const elsewhere: ConsumerId = { nodeId: "node-b", label: watcher.label };
    inbox.registerConsumer(watcher);
    inbox.append(entry({ kind: "a" }));
    inbox.advance(watcher, 1);

    expect(inbox.offsetOf(elsewhere)).toBeNull();
    expect(inbox.registerConsumer(elsewhere)).toBe(1);
    expect(inbox.listConsumers().map((row) => row.consumer.nodeId)).toEqual([
        "node-a",
        "node-b",
    ]);
    inbox.close();
});

test("self-echo is excluded by actor and session at query time", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    inbox.append(entry({ kind: "mine", actor: "nash", session: "opus-91" }));
    inbox.append(entry({ kind: "theirs", actor: "nash", session: "sonnet-93" }));
    inbox.append(entry({ kind: "systemic", actor: null, session: null }));

    const seen = inbox.read(watcher, {
        limit: 10,
        excludeOrigin: { actor: "nash", session: "opus-91" },
    });
    expect(seen.map((row) => row.kind)).toEqual(["theirs", "systemic"]);
    inbox.close();
});

test("addressing filters but never hides an entry from a consumer that asks", () => {
    const inbox = Inbox.open(":memory:");
    inbox.registerConsumer(watcher);
    inbox.append(entry({ kind: "broadcast", address: null }));
    inbox.append(entry({ kind: "for-reviewer", address: "reviewer" }));
    inbox.append(entry({ kind: "for-builder", address: "builder" }));

    const filtered = inbox.read(watcher, { limit: 10, addresses: ["reviewer"] });
    expect(filtered.map((row) => row.kind)).toEqual(["broadcast", "for-reviewer"]);

    const unfiltered = inbox.read(watcher, { limit: 10 });
    expect(unfiltered.map((row) => row.kind)).toEqual([
        "broadcast",
        "for-reviewer",
        "for-builder",
    ]);
    inbox.close();
});

test("concurrent appends leave no gap or reuse in seq", async () => {
    const path = join(temporaryDirectory(), "inbox.db");
    const inbox = Inbox.open(path);
    const appended = await Promise.all(
        Array.from({ length: 50 }, (_unused, index) =>
            Promise.resolve().then(() => inbox.append(entry({ kind: `k${index}` })).seq),
        ),
    );

    const sorted = [...appended].sort((left, right) => left - right);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_unused, index) => index + 1));
    expect(inbox.tail()).toBe(50);
    inbox.close();
});

test("payloads round-trip as inert text", () => {
    const inbox = Inbox.open(":memory:");
    const stored = inbox.append(entry({ kind: "odd", payload: '{"text":"${nope} \\u0000ok"}' }));
    expect(inbox.readAfter(0, { limit: 10 })[0]!.payload).toBe(stored.payload);
    inbox.close();
});

test("an unregistered consumer cannot read or advance", () => {
    const inbox = Inbox.open(":memory:");
    inbox.append(entry({ kind: "a" }));

    expect(() => inbox.read(watcher, { limit: 10 })).toThrow(
        "unknown inbox consumer node-a/reviewer",
    );
    expect(() => inbox.advance(watcher, 1)).toThrow(
        "unknown inbox consumer node-a/reviewer",
    );
    expect(inbox.listConsumers()).toEqual([]);
    inbox.close();
});

function entry(overrides: Partial<InboxEntryInput> = {}): InboxEntryInput {
    return {
        source: "arc",
        kind: "issue.claimed",
        actor: "nash",
        session: "opus-91",
        address: null,
        payload: '{"issue":"nash-91"}',
        ...overrides,
    };
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-inbox-"));
    temporaryDirectories.push(directory);
    return directory;
}
