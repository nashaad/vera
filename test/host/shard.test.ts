import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { belongsToSessionShard, sessionShardIndex } from "../../src/host/shard.ts";
import { indexStoredSessions } from "../../src/host/session-host/storage.ts";
import * as sessionStore from "../../src/store/session-store.ts";

test("FNV-1a hashes UTF-8 bytes as an unsigned 32-bit value", () => {
    expect(sessionShardIndex("", 0x1_0000_0000)).toBe(0x811c9dc5);
    expect(sessionShardIndex("a", 0x1_0000_0000)).toBe(0xe40c292c);
    expect(sessionShardIndex("foobar", 0x1_0000_0000)).toBe(0xbf9cf968);
    expect(sessionShardIndex("☃", 0x1_0000_0000)).toBe(0x86c7c28c);
});

test("each of thirty session ids belongs to exactly one of three shards", () => {
    const counts = [0, 0, 0];
    for (let number = 0; number < 30; number += 1) {
        const id = `crow-${number}`;
        const owners = counts.map((_, index) => belongsToSessionShard(id, { index, count: counts.length }));
        expect(owners.filter(Boolean)).toHaveLength(1);
        counts[sessionShardIndex(id, counts.length)]! += 1;
    }
    expect(counts.every((count) => count > 0)).toBe(true);
});

test("invalid shard counts and indexes are rejected", () => {
    expect(() => sessionShardIndex("crow", 0)).toThrow();
    expect(() => sessionShardIndex("crow", 1.5)).toThrow();
    expect(() => belongsToSessionShard("crow", { index: 3, count: 3 })).toThrow();
});

test("three startup scans read each session file once", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs6-scan-");
    const paths: string[] = [];
    const reads: string[] = [];
    const originalRead = sessionStore.readSessionIndexMetadata;
    let spy: ReturnType<typeof spyOn> | undefined;
    try {
        for (let number = 0; number < 30; number += 1) {
            const id = `crow-${number}`;
            const path = join(home, `${id}.jsonl`);
            await sessionStore.SessionStore.create(path, { sessionId: id, cwd: home });
            paths.push(path);
        }
        spy = spyOn(sessionStore, "readSessionIndexMetadata").mockImplementation(async (path) => {
            reads.push(path);
            return await originalRead(path);
        });
        const scans = await Promise.all([0, 1, 2].map((index) =>
            indexStoredSessions(home, new Map(), () => {}, { index, count: 3 })
        ));
        expect(reads.sort()).toEqual(paths.sort());
        expect(scans.flatMap((scan) => [...scan.keys()]).sort()).toEqual(paths.map((path) =>
            path.slice(path.lastIndexOf("/") + 1, -6)
        ).sort());
    } finally {
        spy?.mockRestore();
        await rm(home, { recursive: true, force: true });
    }
});
