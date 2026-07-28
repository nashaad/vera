import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Inbox, type ConsumerId, type InboxEntryInput } from "../../src/store/inbox.ts";

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

test("offsets never move backwards", () => {
    const inbox = Inbox.open(":memory:");
    inbox.appendAll([entry({ kind: "a" }), entry({ kind: "b" }), entry({ kind: "c" })]);

    inbox.advance(watcher, 3);
    expect(inbox.advance(watcher, 1)).toBe(3);
    inbox.close();
});

test("offsets are durable per node and label across restarts", () => {
    const path = join(temporaryDirectory(), "inbox", "inbox.db");
    const first = Inbox.open(path);
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
