import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assertDistinctSockets,
    cloneVeraHome,
    hashedInstanceRoot,
} from "../../src/host/home-clone.ts";
import { Inbox } from "../../src/store/inbox.ts";

test("cloneVeraHome copies the home and scrubs live host identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-clone-"));
    const source = join(root, "daily");
    const destination = join(root, "candidate");
    mkdirSync(join(source, "runtime"), { recursive: true });
    mkdirSync(join(source, "machine"), { recursive: true });
    writeFileSync(join(source, "config.json"), "{\"schema_version\":1}\n");
    writeFileSync(join(source, "runtime", "host.sock"), "socket");
    writeFileSync(
        join(source, "runtime", "host.json"),
        JSON.stringify({ pid: 1, socket_path: join(source, "runtime", "host.sock") }),
    );
    writeFileSync(join(source, "runtime", "session.jsonl"), "session\n");
    writeFileSync(join(source, "machine", "auth.json"), "{\"token\":\"secret\"}\n");
    chmodSync(join(source, "machine", "auth.json"), 0o600);

    try {
        const cloned = await cloneVeraHome({
            sourceHome: source,
            destinationHome: destination,
        });
        expect(cloned.destinationHome).toBe(destination);
        expect(readFileSync(join(destination, "config.json"), "utf8"))
            .toBe("{\"schema_version\":1}\n");
        expect(readFileSync(join(destination, "runtime", "session.jsonl"), "utf8"))
            .toBe("session\n");
        expect(existsSync(join(destination, "runtime", "host.sock"))).toBe(false);
        expect(existsSync(join(destination, "runtime", "host.json"))).toBe(false);
        expect(existsSync(join(source, "runtime", "host.sock"))).toBe(true);
        expect(statSync(join(destination, "machine", "auth.json")).mode & 0o777)
            .toBe(0o600);
        assertDistinctSockets(destination, source);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("cloneVeraHome overlays sqlite backups from the live host connections", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-clone-db-"));
    const source = join(root, "daily");
    const destination = join(root, "candidate");
    mkdirSync(join(source, "runtime"), { recursive: true });
    const inbox = Inbox.open(join(source, "runtime", "inbox.db"));
    try {
        inbox.append({
            source: "test",
            kind: "note",
            payload: "{\"text\":\"live\"}",
        });
        await cloneVeraHome({
            sourceHome: source,
            destinationHome: destination,
            inbox,
        });
        const copy = Inbox.open(join(destination, "runtime", "inbox.db"));
        try {
            expect(copy.readAfter(0, { limit: 10 }).map((row) => row.payload))
                .toEqual(["{\"text\":\"live\"}"]);
        } finally {
            copy.close();
        }
    } finally {
        inbox.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a failed clone removes only staging and leaves the daily home", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-home-clone-fail-"));
    const source = join(root, "daily");
    const destination = join(root, "candidate");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "config.json"), "ok\n");
    mkdirSync(destination);
    try {
        await expect(cloneVeraHome({
            sourceHome: source,
            destinationHome: destination,
        })).rejects.toThrow("already exists");
        expect(readFileSync(join(source, "config.json"), "utf8")).toBe("ok\n");
        expect(existsSync(`${destination}.staging-${process.pid}`)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("hashedInstanceRoot stays short for a long worktree identity", () => {
    const root = hashedInstanceRoot(
        "/Users/nash/Projects/vera/.worktrees/a-very-long-feature-name",
        "/tmp/vera-dev",
    );
    expect(root.startsWith("/tmp/vera-dev/")).toBe(true);
    expect(root.length).toBeLessThan(80);
    expect(candidateWouldFit(root)).toBe(true);
});

function candidateWouldFit(home: string): boolean {
    return join(home, "runtime", "host.sock").length < 100;
}
