import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "bun:test";
import {
    clearHistory,
    HISTORY_PAGE_SIZE,
    HISTORY_STORAGE_KEY,
    historyVersion,
    listVisits,
    recordVisit,
    subscribeHistory,
} from "../../clients/ui/src/browser/history.ts";
import { recordRecent, RECENT_STORAGE_KEY } from "../../clients/ui/src/browser/recents.ts";

const savedWindow = globalThis.window;
const values = new Map<string, string>();
const testStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
} as Storage;

function useTestStorage(): void {
    values.clear();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { localStorage: testStorage },
    });
}

afterEach(() => {
    values.clear();
    if (savedWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: savedWindow });
});

test("caps history, pages results, and searches title and full URL without trimming addresses", () => {
    useTestStorage();
    for (let index = 0; index < 505; index++) {
        recordVisit(`https://example.com/page/${index}?q=Crow#part`, `Page ${index}`);
    }
    expect(listVisits("crow", 0).entries).toHaveLength(HISTORY_PAGE_SIZE);
    expect(listVisits("crow", 0).hasMore).toBe(true);
    const last = listVisits("crow", 450);
    expect(last.entries).toHaveLength(50);
    expect(last.hasMore).toBe(false);
    expect(last.entries[0]?.url).toBe("https://example.com/page/54?q=Crow#part");
    expect(listVisits("PAGE 504", 0).entries[0]?.title).toBe("Page 504");
    expect(listVisits("missing", 0)).toEqual({ entries: [], hasMore: false });
});

test("collapses an immediately consecutive exact URL and keeps separated revisits", () => {
    useTestStorage();
    recordVisit("https://example.com/a?x=1#part", "First");
    recordVisit("https://example.com/a?x=1#part", "Consecutive");
    expect(listVisits("", 0).entries).toHaveLength(1);
    expect(listVisits("", 0).entries[0]?.title).toBe("Consecutive");
    recordVisit("https://example.com/b", "Middle");
    recordVisit("https://example.com/a?x=1#part", "Again");
    const entries = listVisits("", 0).entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ url: "https://example.com/a?x=1#part", title: "Again" });
    recordVisit("https://example.com/a?x=2#part", "Different URL");
    expect(listVisits("", 0).entries).toHaveLength(4);
});

test("rejects corrupt, oversized, out-of-order and invalid saved data", () => {
    useTestStorage();
    values.set(HISTORY_STORAGE_KEY, "{");
    expect(listVisits("", 0).entries).toEqual([]);
    values.set(HISTORY_STORAGE_KEY, "x".repeat(1024 * 1024 + 1));
    expect(listVisits("", 0).entries).toEqual([]);
    const valid = { url: "https://example.com/valid", title: "Valid", visitedAt: 2 };
    values.set(HISTORY_STORAGE_KEY, JSON.stringify([valid, { ...valid, visitedAt: 3 }]));
    expect(listVisits("", 0).entries).toEqual([]);
    values.set(HISTORY_STORAGE_KEY, JSON.stringify([{ ...valid, visitedAt: 8.64e15 + 1 }]));
    expect(listVisits("", 0).entries).toEqual([]);
    values.set(HISTORY_STORAGE_KEY, JSON.stringify([{ ...valid, visitedAt: 1e300 }]));
    expect(listVisits("", 0).entries).toEqual([]);
    values.set(HISTORY_STORAGE_KEY, JSON.stringify([{ ...valid, url: "https://example.com/" + "x".repeat(8192) }]));
    expect(listVisits("", 0).entries).toEqual([]);
});

test("keeps visit timestamps non-increasing when the system clock moves backward", () => {
    useTestStorage();
    const originalNow = Date.now;
    try {
        Date.now = () => 2000;
        recordVisit("https://example.com/first", "First");
        Date.now = () => 1000;
        recordVisit("https://example.com/second", "Second");
    } finally {
        Date.now = originalNow;
    }
    const entries = listVisits("", 0).entries;
    expect(entries.map((entry) => entry.visitedAt)).toEqual([2000, 2000]);
    expect(entries[0]?.url).toBe("https://example.com/second");
});

test("enforces count and serialized-size bounds when writing", () => {
    useTestStorage();
    for (let index = 0; index < 500; index++) {
        recordVisit(`https://example.com/${index}/` + "x".repeat(2000), `Page ${index}`);
    }
    const serialized = values.get(HISTORY_STORAGE_KEY) ?? "";
    expect(serialized.length).toBeLessThanOrEqual(1024 * 1024);
    expect(JSON.parse(serialized).length).toBeLessThanOrEqual(500);
    expect(listVisits("", 0).entries[0]?.url).toContain("/499/");
});

test("clears browser history and browser recents while preserving annex recents", () => {
    useTestStorage();
    recordRecent({ kind: "annex", target: "/x/crow/page", title: "Annex" });
    recordRecent({ kind: "browser", target: "https://example.com/recent", title: "Browser" });
    recordVisit("https://example.com/history", "History");
    const startVersion = historyVersion();
    let notifications = 0;
    const unsubscribe = subscribeHistory(() => { notifications++; });
    clearHistory();
    unsubscribe();
    expect(listVisits("", 0).entries).toEqual([]);
    expect(values.has(HISTORY_STORAGE_KEY)).toBe(false);
    const recents = JSON.parse(values.get(RECENT_STORAGE_KEY) ?? "[]") as { kind: string }[];
    expect(recents.map((item) => item.kind)).toEqual(["annex"]);
    expect(historyVersion()).toBe(startVersion + 1);
    expect(notifications).toBe(1);
});

test("persists history through separate processes using disk-backed web storage", async () => {
    const folder = mkdtempSync(join(tmpdir(), "vera-pane-history-"));
    try {
        const bundle = await Bun.build({
            entrypoints: [join(import.meta.dir, "../../clients/ui/src/browser/history.ts")],
            target: "node",
            format: "esm",
        });
        expect(bundle.success).toBe(true);
        const module = join(folder, "history.mjs");
        writeFileSync(module, await bundle.outputs[0]!.text());
        const script = `globalThis.window = { localStorage: globalThis.localStorage };
            const { listVisits, recordVisit } = await import(${JSON.stringify(pathToFileURL(module).href)});
            if (process.argv[1] === "save") recordVisit("https://example.com/query?q=crow#part", "Crow page");
            console.log(JSON.stringify(listVisits("crow", 0).entries));`;
        const run = (mode: string): string => execFileSync("node", [
            "--experimental-webstorage", `--localstorage-file=${join(folder, "localstorage")}`,
            "--input-type=module", "-e", script, mode,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        expect(JSON.parse(run("save"))).toMatchObject([{ url: "https://example.com/query?q=crow#part", title: "Crow page" }]);
        expect(JSON.parse(run("read"))).toMatchObject([{ url: "https://example.com/query?q=crow#part", title: "Crow page" }]);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
