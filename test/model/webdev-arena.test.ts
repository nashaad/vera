import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    parseWebDevArenaSnapshot,
    readWebDevArenaSnapshot,
    refreshWebDevArena,
    webDevArenaSnapshotDate,
} from "../../src/model/webdev-arena.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function cacheDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-webdev-"));
    directories.push(directory);
    return directory;
}

const PAGE = 100;

function rowsFor(offset: number, total: number): unknown[] {
    const end = Math.min(offset + PAGE, total);
    const rows = [];
    for (let index = offset; index < end; index += 1) {
        rows.push({
            row_idx: index,
            row: {
                model_name: index === 0 ? "claude-opus-5-max" : `other-${index}`,
                rating: index === 0 ? 1690.639 : index,
                category: index === 0 ? "overall" : "webdev",
                rank: index + 1,
                vote_count: 40,
                ...(index === 0
                    ? { leaderboard_publish_date: "2026-08-21" }
                    : {}),
            },
        });
    }
    return rows;
}

function respondPages(total: number): typeof globalThis.fetch {
    return (async (input: string | URL) => {
        const url = new URL(String(input));
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return {
            ok: true,
            json: async () => ({
                num_rows_total: total,
                rows: rowsFor(offset, total),
            }),
        };
    }) as unknown as typeof globalThis.fetch;
}

describe("WebDev Arena snapshot", () => {
    test("pages the rows API and keeps every category in the cache", async () => {
        const directory = cacheDir();
        const snapshot = await refreshWebDevArena({
            cacheDir: directory,
            fetch: respondPages(101),
            endpoint: "https://example.test/rows",
        });

        expect(snapshot?.rows).toHaveLength(101);
        expect(snapshot?.rows[0]?.model_name).toBe("claude-opus-5-max");
        expect(snapshot?.rows[100]?.model_name).toBe("other-100");
        expect(snapshot?.rows.some((row) => row.category === "webdev")).toBe(true);
        expect(snapshot?.license).toBe("CC-BY-4.0");
        expect(snapshot?.leaderboard_publish_date).toBe("2026-08-21");
        expect(webDevArenaSnapshotDate(snapshot)).toBe("2026-08-21");
        expect(JSON.parse(readFileSync(join(directory, "webdev-arena.json"), "utf8")))
            .toMatchObject({ schema_version: 1, config: "webdev" });
    });

    test("a failed fetch keeps the last snapshot", async () => {
        const directory = cacheDir();
        await refreshWebDevArena({
            cacheDir: directory,
            fetch: respondPages(2),
            endpoint: "https://example.test/rows",
        });

        const kept = await refreshWebDevArena({
            cacheDir: directory,
            fetch: (() => Promise.reject(new Error("offline"))) as unknown as
                typeof globalThis.fetch,
            endpoint: "https://example.test/rows",
        });

        expect(kept?.rows).toHaveLength(2);
    });

    test("nothing cached and nothing fetched yields no snapshot", async () => {
        expect(await refreshWebDevArena({
            cacheDir: cacheDir(),
            fetch: (() => Promise.reject(new Error("offline"))) as unknown as
                typeof globalThis.fetch,
        })).toBeUndefined();
    });

    test("a snapshot inside the max age is answered without a request", async () => {
        const directory = cacheDir();
        await refreshWebDevArena({
            cacheDir: directory,
            fetch: respondPages(2),
            endpoint: "https://example.test/rows",
        });

        let asked = false;
        const snapshot = await refreshWebDevArena({
            cacheDir: directory,
            maxAgeMs: 3_600_000,
            fetch: (() => {
                asked = true;
                return Promise.reject(new Error("must not ask"));
            }) as unknown as typeof globalThis.fetch,
        });

        expect(asked).toBe(false);
        expect(snapshot?.rows).toHaveLength(2);
    });

    test("parse rejects a damaged file rather than inventing scores", () => {
        expect(parseWebDevArenaSnapshot({ schema_version: 1 })).toBeUndefined();
        const directory = cacheDir();
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "webdev-arena.json"), "{not json");
        expect(readWebDevArenaSnapshot(directory)).toBeUndefined();
    });
});
