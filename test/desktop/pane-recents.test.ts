import { describe, expect, test } from "bun:test";
import { addRecent, parseRecents, readRecents, RECENT_STORAGE_KEY, writeRecents, type RecentPage } from "../../clients/ui/src/browser/recents.ts";
import { moveRecentSelection, recentKey, selectedRecent } from "../../clients/ui/src/workbench/pane-search.ts";

describe("pane recents", () => {
    test("caps and deduplicates in most recent order", () => {
        let items: RecentPage[] = [];
        for (let i = 0; i < 25; i++) items = addRecent(items, { kind: "browser", target: `https://example.com/${i}`, title: `${i}` });
        expect(items).toHaveLength(20);
        items = addRecent(items, { kind: "browser", target: "https://example.com/10", title: "Ten" });
        expect(items[0]?.title).toBe("Ten");
        expect(items.filter((item) => item.target.endsWith("/10"))).toHaveLength(1);
    });

    test("selection follows the visible recent when records change", () => {
        const first: RecentPage = { kind: "browser", target: "https://example.com/first", title: "First" };
        const second: RecentPage = { kind: "browser", target: "https://example.com/second", title: "Second" };
        const selected = moveRecentSelection([first, second], undefined, -1);
        expect(selected).toBe(recentKey(second));
        expect(selectedRecent([second, first], selected)).toEqual(second);
        expect(selectedRecent([first], selected)).toBeUndefined();
        expect(moveRecentSelection([first], selected, 1)).toBe(recentKey(first));
    });

    test("rejects malformed saved entries and reloads valid entries", () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
        } as Storage;
        const valid: RecentPage = { kind: "annex", target: "/x/crow/page?id=1", title: "Crow" };
        writeRecents(storage, [valid]);
        expect(readRecents(storage)).toEqual([valid]);
        values.set(RECENT_STORAGE_KEY, JSON.stringify([valid, { kind: "browser", target: "javascript:alert(1)", title: "Bad" }, { kind: "annex", target: "//evil", title: "Bad" }, null]));
        expect(readRecents(storage)).toEqual([valid]);
        expect(parseRecents("bad")).toEqual([]);
    });
});
