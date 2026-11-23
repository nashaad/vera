import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionCacheStore, SessionCacheWriter } from "../../clients/desktop/src/session-cache-store.ts";
import { sessionCachePath } from "../../clients/ui/src/protocol/sessionCache.ts";

const homes: string[] = [];
function home(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-session-cache-"));
    homes.push(path);
    return path;
}

afterEach(() => {
    for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

class CountingStore extends SessionCacheStore {
    saves = 0;
    override save(input: unknown): boolean {
        this.saves += 1;
        return super.save(input);
    }
}

const request = JSON.stringify({ type: "list_agents", limit: 50, order: "recent" });
const reply = (names: readonly string[]): string => JSON.stringify({
    type: "agent_list",
    total: 1_234,
    agents: names.map((name, index) => ({
        id: `id-${index}`, name, workspace: "/work", status: "working", live: true,
        chat: false, private_field: "not cached",
    })),
});

test("@core session cache persists one bounded page within its own home", () => {
    const first = home();
    const second = home();
    const store = new CountingStore(first);
    const writer = new SessionCacheWriter(store);
    expect(new SessionCacheStore(second).load()).toBeUndefined();
    writer.accept(request, reply(Array.from({ length: 60 }, (_, index) => `Crow ${index}`)));
    expect(existsSync(sessionCachePath(first))).toBe(false);
    writer.flush();
    const rows = new SessionCacheStore(first).load()!;
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({ id: "id-0", name: "Crow 0", workspace: "/work", status: "working", live: true, archived: false, chat: false });
    expect(new SessionCacheStore(second).load()).toBeUndefined();
    const text = readFileSync(sessionCachePath(first), "utf8");
    expect(text).not.toContain("private_field");
    expect(text).not.toContain("1234");
    expect(store.saves).toBe(1);
    writer.accept(request, reply(Array.from({ length: 60 }, (_, index) => `Crow ${index}`)));
    writer.flush();
    expect(store.saves).toBe(1);
    writer.accept(request, reply(["New crow"]));
    writer.accept(request, reply(["Newest crow"]));
    expect(store.saves).toBe(1);
    writer.flush();
    expect(store.saves).toBe(2);
    expect(store.load()?.[0]?.name).toBe("Newest crow");
});

test("@core session cache ignores invalid files and unrelated pages", () => {
    const path = home();
    const store = new SessionCacheStore(path);
    const writer = new SessionCacheWriter(store);
    writer.accept(JSON.stringify({ type: "list_agents", limit: 50, order: "recent", cursor: "next" }), reply(["Other page"]));
    writer.flush();
    expect(store.load()).toBeUndefined();
    writer.accept(request, reply(["Crow"]));
    writer.flush();
    writeFileSync(sessionCachePath(path), "not json");
    expect(new SessionCacheStore(path).load()).toBeUndefined();
    expect(existsSync(`${sessionCachePath(path)}.bad`)).toBe(true);
    writeFileSync(sessionCachePath(path), "x".repeat(256 * 1024 + 1));
    expect(new SessionCacheStore(path).load()).toBeUndefined();
    expect(existsSync(`${sessionCachePath(path)}.bad`)).toBe(true);
});
