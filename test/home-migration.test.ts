import { afterAll, expect, test } from "bun:test";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    HomeMigrationError,
    migrateHome,
    readHomeMigrationReceipt,
    rollbackHomeMigration,
} from "../src/home-migration.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-home-mig-"));
    temporaryDirectories.push(directory);
    return directory;
}

function writeTree(
    root: string,
    files: Record<string, string>,
): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const [relative, contents] of Object.entries(files)) {
        const path = join(root, relative);
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(path, contents, { mode: 0o600 });
    }
}

function snapshot(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    walk(root, "", out);
    return out;
}

function walk(
    root: string,
    relative: string,
    out: Record<string, string>,
): void {
    const path = relative.length === 0 ? root : join(root, relative);
    for (const name of readdirSync(path).sort()) {
        if (name.startsWith(".")) continue;
        const child = relative.length === 0 ? name : join(relative, name);
        const full = join(root, child);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) {
            out[child] = `symlink:${readlinkSync(full)}`;
            continue;
        }
        if (stat.isDirectory()) {
            walk(root, child, out);
            continue;
        }
        out[child] = readFileSync(full, "utf8");
    }
}

test("a one-profile home migrates and rolls back byte for byte", () => {
    const parent = temporaryDirectory();
    const home = join(parent, ".vera");
    writeTree(home, {
        "machine/auth.json": "{\"token\":\"secret\"}",
        "profiles/default/config.json": "{\"model\":\"alpha\"}",
        "profiles/default/memory/note.md": "keep me",
        "profiles/default/runtime/sessions/one.jsonl": "session",
    });
    const before = snapshot(home);

    const migrated = migrateHome(home, {
        now: () => new Date("2026-08-31T20:00:00.000Z"),
    });
    expect(migrated.status).toBe("migrated");
    expect(readFileSync(join(home, "config.json"), "utf8"))
        .toBe("{\"model\":\"alpha\"}");
    expect(readFileSync(join(home, "memory/note.md"), "utf8")).toBe("keep me");
    expect(readFileSync(join(home, "machine/auth.json"), "utf8"))
        .toBe("{\"token\":\"secret\"}");
    expect(readdirSync(home).includes("profiles")).toBe(false);
    expect(snapshot(migrated.backup!)).toEqual(before);

    const rolled = rollbackHomeMigration(home);
    expect(rolled.status).toBe("rolled_back");
    expect(snapshot(home)).toEqual(before);
    expect(readHomeMigrationReceipt(home)).toBeUndefined();
});

test("absolute paths under profiles/default move to the new home", () => {
    const home = join(temporaryDirectory(), ".vera");
    const oldPath = join(home, "profiles", "default", "extensions", "example.context");
    writeTree(home, {
        "profiles/default/config.json": JSON.stringify({
            extensions: [{ path: oldPath, enabled: true }],
        }),
        "profiles/default/extensions/example.context/package.json": "{}",
    });
    migrateHome(home);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.extensions[0].path).toBe(join(home, "extensions", "example.context"));
    expect(config.extensions[0].path.includes("profiles/default")).toBe(false);
});

test("a second profile stays in backup and does not reach the live home", () => {
    const home = join(temporaryDirectory(), ".vera");
    writeTree(home, {
        "machine/auth.json": "{}",
        "profiles/default/config.json": "default-config",
        "profiles/default/memory/shared.md": "shared",
        "profiles/dev/config.json": "dev-config",
        "stray.txt": "unknown",
    });
    mkdirSync(join(home, "profiles/dev"), { recursive: true });
    symlinkSync("../default/memory", join(home, "profiles/dev/memory"));

    const migrated = migrateHome(home);
    expect(migrated.otherProfiles).toEqual(["dev"]);
    expect(migrated.unknownEntries).toEqual(["stray.txt"]);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("default-config");
    expect(readFileSync(join(home, "memory/shared.md"), "utf8")).toBe("shared");
    expect(readdirSync(home).includes("stray.txt")).toBe(false);
    expect(readdirSync(home).includes("profiles")).toBe(false);

    const backupDev = join(migrated.backup!, "profiles", "dev");
    expect(readFileSync(join(backupDev, "config.json"), "utf8")).toBe("dev-config");
    expect(lstatSync(join(backupDev, "memory")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(backupDev, "memory"))).toBe("../default/memory");
    expect(readFileSync(join(migrated.backup!, "stray.txt"), "utf8"))
        .toBe("unknown");
});

test("a crash after staging leaves the old home and resume finishes", () => {
    const home = join(temporaryDirectory(), ".vera");
    writeTree(home, {
        "profiles/default/config.json": "ok",
    });
    const before = snapshot(home);
    expect(() => migrateHome(home, {
        hooks: {
            afterStagingBuilt: () => {
                throw new Error("stop after staging");
            },
        },
    })).toThrow("stop after staging");
    expect(snapshot(home)).toEqual(before);
    expect(readHomeMigrationReceipt(home)?.phase).toBe("staging");

    const resumed = migrateHome(home);
    expect(resumed.status).toBe("resumed");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("ok");
    expect(readdirSync(home).includes("profiles")).toBe(false);
});

test("a crash after the backup rename resume-swaps the new home", () => {
    const home = join(temporaryDirectory(), ".vera");
    writeTree(home, {
        "profiles/default/config.json": "ok",
        "profiles/dev/config.json": "dev",
    });
    expect(() => migrateHome(home, {
        hooks: {
            afterHomeRenamedToBackup: () => {
                throw new Error("stop after backup");
            },
        },
    })).toThrow("stop after backup");
    const receipt = readHomeMigrationReceipt(home);
    expect(receipt?.phase).toBe("swapping");
    expect(homeExists(home)).toBe(false);

    const resumed = migrateHome(home);
    expect(resumed.status).toBe("resumed");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("ok");
    expect(readdirSync(home).includes("profiles")).toBe(false);
    expect(readFileSync(
        join(resumed.backup!, "profiles", "dev", "config.json"),
        "utf8",
    )).toBe("dev");
});

test("an already flat home is a no-op", () => {
    const home = join(temporaryDirectory(), ".vera");
    writeTree(home, { "config.json": "flat" });
    const result = migrateHome(home);
    expect(result.status).toBe("already_flat");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("flat");
});

test("profiles without default is refused", () => {
    const home = join(temporaryDirectory(), ".vera");
    writeTree(home, { "profiles/dev/config.json": "dev" });
    expect(() => migrateHome(home)).toThrow(HomeMigrationError);
});

function homeExists(home: string): boolean {
    try {
        readdirSync(home);
        return true;
    } catch {
        return false;
    }
}
