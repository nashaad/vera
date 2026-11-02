import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultHostLockPath } from "../../src/host/lockfile.ts";
import { spawnVeraLookingProcess } from "../support/vera-looking-process.ts";
import {
    currentSymlinkPath,
    rollbackSymlinkPath,
    veraShareRoot,
} from "../../src/release/layout.ts";
import {
    damagedHostLockHold,
    isReleaseReferenced,
    listReleaseReferences,
    referencedBuildIds,
    referenceReasons,
    rollbackProtectedBuildIds,
} from "../../src/release/references.ts";

function writeCurrent(prefix: string, buildId: string): void {
    mkdirSync(veraShareRoot(prefix), { recursive: true });
    const current = currentSymlinkPath(prefix);
    try {
        rmSync(current);
    } catch {
        // First write.
    }
    symlinkSync(join("releases", buildId), current);
}

test("the activated current is a referenced build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-current-"));
    try {
        writeCurrent(prefix, "vera-activated");
        expect([...referencedBuildIds(prefix)]).toContain("vera-activated");
        expect(isReleaseReferenced("vera-activated", prefix)).toBe(true);
        expect(referenceReasons("vera-activated", prefix)).toEqual(["activated"]);
        expect(isReleaseReferenced("vera-orphan", prefix)).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a live host.json pid protects that host build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-host-"));
    const lockPath = defaultHostLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 3,
        pid: process.pid,
        started_at: new Date().toISOString(),
        socket_path: "/tmp/vera-ref-host.sock",
        build_id: "vera-live-host",
    }, null, 2)}\n`);
    try {
        expect([...referencedBuildIds(prefix)]).toContain("vera-live-host");
        expect(referenceReasons("vera-live-host", prefix)).toEqual(["live-host"]);
    } finally {
        rmSync(lockPath, { force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a dead host pid is not a live reference", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-dead-"));
    const lockPath = defaultHostLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 3,
        pid: 2_147_483_647,
        started_at: new Date().toISOString(),
        socket_path: "/tmp/vera-ref-dead.sock",
        build_id: "vera-dead-host",
    }, null, 2)}\n`);
    try {
        expect([...referencedBuildIds(prefix)]).not.toContain("vera-dead-host");
    } finally {
        rmSync(lockPath, { force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("an upgrade journal protects both named builds when present", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-upgrade-"));
    try {
        mkdirSync(veraShareRoot(prefix), { recursive: true });
        writeFileSync(
            join(veraShareRoot(prefix), "upgrade.json"),
            `${JSON.stringify({
                phase: "activating",
                from_build_id: "vera-from",
                to_build_id: "vera-to",
                host_was_running: true,
            }, null, 2)}\n`,
        );
        const ids = referencedBuildIds(prefix);
        expect(ids.has("vera-from")).toBe(true);
        expect(ids.has("vera-to")).toBe(true);
        expect(referenceReasons("vera-from", prefix)).toEqual(["upgrade"]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a rollback pin protects that build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-rollback-"));
    try {
        expect(rollbackProtectedBuildIds(prefix)).toEqual([]);
        mkdirSync(veraShareRoot(prefix), { recursive: true });
        symlinkSync(join("releases", "vera-known-good"), rollbackSymlinkPath(prefix));
        expect(rollbackProtectedBuildIds(prefix)).toEqual(["vera-known-good"]);
        expect(isReleaseReferenced("vera-known-good", prefix)).toBe(true);
        expect(referenceReasons("vera-known-good", prefix)).toEqual(["rollback"]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

function withHostLock(contents: string, body: () => void): void {
    const lockPath = defaultHostLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, contents);
    try {
        body();
    } finally {
        rmSync(lockPath, { force: true });
    }
}

const DEAD_PID = 2_147_483_647;

test("a damaged host.json naming a live Vera process holds every release", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-damaged-live-"));
    const directory = mkdtempSync(join(tmpdir(), "vera-ref-damaged-host-"));
    const host = spawnVeraLookingProcess(directory);
    try {
        withHostLock(
            `{"schema_version": 3, "pid": ${host.pid}, "started_at": "20`,
            () => {
                const hold = damagedHostLockHold();
                expect(hold).toContain(`PID ${host.pid}`);
                expect(hold).toContain("damaged");
                expect(isReleaseReferenced("vera-any-build", prefix)).toBe(true);
                expect(referenceReasons("vera-any-build", prefix)).toEqual([
                    "host-lock-damaged",
                ]);
            },
        );
    } finally {
        host.kill("SIGKILL");
        await host.exited;
        rmSync(directory, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a damaged host.json with no readable pid holds every release", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-damaged-nopid-"));
    try {
        withHostLock(`{"schema_version": 3, "socket_pa`, () => {
            expect(damagedHostLockHold()).toContain("no PID");
            expect(isReleaseReferenced("vera-any-build", prefix)).toBe(true);
        });
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a damaged host.json naming a dead process does not hold releases", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-damaged-dead-"));
    try {
        withHostLock(`{"schema_version": 3, "pid": ${DEAD_PID}, "star`, () => {
            expect(damagedHostLockHold()).toBeUndefined();
            expect(isReleaseReferenced("vera-any-build", prefix)).toBe(false);
        });
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a damaged host.json naming a live process that is not Vera does not hold releases", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-ref-damaged-other-"));
    const other = Bun.spawn(
        [process.execPath, "-e", "await Bun.sleep(60000)"],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    try {
        withHostLock(`{"schema_version": 3, "pid": ${other.pid}, "star`, () => {
            expect(damagedHostLockHold()).toBeUndefined();
            expect(isReleaseReferenced("vera-any-build", prefix)).toBe(false);
        });
    } finally {
        other.kill("SIGKILL");
        await other.exited;
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a valid host.json does not hold every release", () => {
    withHostLock(
        `${JSON.stringify({
            schema_version: 3,
            pid: process.pid,
            started_at: new Date().toISOString(),
            socket_path: "/tmp/vera-ref-valid.sock",
            build_id: "vera-valid-host",
        })}\n`,
        () => {
            expect(damagedHostLockHold()).toBeUndefined();
        },
    );
});
