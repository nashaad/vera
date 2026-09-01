import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Inbox } from "../../src/store/inbox.ts";
import { backupSqliteDatabase } from "../../src/store/sqlite-backup.ts";

test("copying a WAL main file misses later commits; backup does not", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-sqlite-backup-"));
    const sourcePath = join(root, "live.db");
    const naivePath = join(root, "naive.db");
    const backupPath = join(root, "backup.db");
    const live = new Database(sourcePath);
    try {
        live.exec("PRAGMA journal_mode = WAL");
        live.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)");
        live.exec("INSERT INTO items (body) VALUES ('first')");
        copyFileSync(sourcePath, naivePath);
        live.exec("INSERT INTO items (body) VALUES ('from-wal')");
        backupSqliteDatabase(live, backupPath);

        const naive = new Database(naivePath);
        try {
            const bodies = naive.query<{ body: string }, []>(
                "SELECT body FROM items",
            ).all().map((row) => row.body);
            expect(bodies).not.toContain("from-wal");
        } catch (error) {
            expect(String(error)).toMatch(/SQLITE|unable to open/i);
        } finally {
            naive.close();
        }

        const backup = new Database(backupPath);
        try {
            expect(
                backup.query<{ body: string }, []>("SELECT body FROM items")
                    .all()
                    .map((row) => row.body),
            ).toEqual(["first", "from-wal"]);
        } finally {
            backup.close();
        }
    } finally {
        live.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("an inbox backup includes a row that still lives in the WAL", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-inbox-backup-"));
    const inbox = Inbox.open(join(root, "inbox.db"));
    try {
        inbox.append({
            source: "test",
            kind: "note",
            payload: "{\"text\":\"wal-row\"}",
        });
        const destination = join(root, "copy", "inbox.db");
        inbox.backupTo(destination);
        const copy = Inbox.open(destination);
        try {
            expect(copy.readAfter(0, { limit: 10 }).map((entry) => entry.payload))
                .toEqual(["{\"text\":\"wal-row\"}"]);
        } finally {
            copy.close();
        }
    } finally {
        inbox.close();
        rmSync(root, { recursive: true, force: true });
    }
});
