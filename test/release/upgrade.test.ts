import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    releaseDirectory,
    upgradeJournalPath,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";
import {
    recoverInterruptedUpgrade,
    upgradeLocalInstall,
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";
import { spawnVeraLookingProcess } from "../support/vera-looking-process.ts";

function writeDummyRelease(prefix: string, buildId: string): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), serializeReleaseManifest({
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: VERA_PRODUCT_VERSION,
        source_revision: "abc",
        build_id: buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: `sha256:${"ab".repeat(32)}`,
        built_at: "2026-08-31T00:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    }));
    writeFileSync(join(root, "vera"), "#!/bin/sh\necho dummy\n", {
        encoding: "utf8",
        mode: 0o755,
    });
    chmodSync(join(root, "vera"), 0o755);
    return root;
}

test("upgradeLocalInstall moves current from the previous release to the new one", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-ok-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        const started: string[] = [];
        const result = await upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => "absent",
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(result.fromBuildId).toBe("vera-old");
        expect(result.manifest.build_id).toBe("vera-new");
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-new");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(existsSync(previous)).toBe(true);
        expect(started).toEqual([]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("upgradeLocalInstall restarts a drained host from the new release", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-restart-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        const started: string[] = [];
        await upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => "stopped",
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(currentReleaseBuildId(prefix)).toBe("vera-new");
        expect(started).toEqual([next]);
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a verify failure leaves the previous release active", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-verify-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        let packed = false;
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => {
                packed = true;
                return {
                    prefix,
                    releaseRoot: next,
                    manifest: readStampedRelease(next),
                };
            },
            verify: () => {
                throw new Error("annex digest mismatch");
            },
            drainHost: async () => "absent",
            startHost: async () => {
                throw new Error("startHost must not run");
            },
        })).rejects.toThrow(/annex digest mismatch/);
        expect(packed).toBe(true);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(existsSync(next)).toBe(true);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a start failure restores the previous release and restarts it", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-start-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        const started: string[] = [];
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => "stopped",
            startHost: async (root) => {
                started.push(root);
                if (root === next) {
                    throw new Error("new host refused to boot");
                }
            },
        })).rejects.toThrow(/new host refused to boot/);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
        expect(started[0]).toBe(next);
        expect(started[1]).toBe(previous);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a drain that cannot stop the host leaves the previous release active", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-drain-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        await expect(upgradeLocalInstall({
            prefix,
            pack: async () => ({
                prefix,
                releaseRoot: next,
                manifest: readStampedRelease(next),
            }),
            verify: () => undefined,
            drainHost: async () => {
                throw new Error(
                    "Resident Vera host PID 9 is still running. "
                        + "The previous release is still active.",
                );
            },
            startHost: async () => {
                throw new Error("startHost must not run");
            },
        })).rejects.toThrow(/still running/);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a drain that cannot identify the host refuses without signalling it or clearing its lockfile", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-upgrade-unverified-"));
    const veraHome = join(root, "home");
    const noPs = join(root, "bin");
    mkdirSync(join(veraHome, "runtime"), { recursive: true });
    mkdirSync(noPs);
    const lockPath = join(veraHome, "runtime", "host.json");
    const bystander = Bun.spawn(["sleep", "30"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: bystander.pid,
            started_at: "2000-01-01T00:00:00.000Z",
            socket_path: join(veraHome, "runtime", "host.sock"),
        }));
        const upgrade = join(import.meta.dir, "..", "..", "src", "release", "upgrade.ts");
        const script = `
            import { defaultDrainHost } from ${JSON.stringify(upgrade)};
            try {
                console.log("returned " + await defaultDrainHost());
            } catch (error) {
                console.log("threw " + (error as Error).message);
            }
        `;
        const ran = Bun.spawnSync([process.execPath, "-e", script], {
            env: { HOME: root, PATH: noPs, VERA_HOME: veraHome },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        expect(ran.stdout.toString().trim()).toBe(
            `threw Could not confirm PID ${bystander.pid} is the Vera host`
                + " (process start time unreadable); left it running and kept"
                + " its lockfile. Try again. Run 'bun run install:local' again."
                + " The previous release is still active.",
        );
        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
    }
});

function drainInSubprocess(
    root: string,
    veraHome: string,
    operation: "install" | "rollback",
): string {
    const upgrade = join(import.meta.dir, "..", "..", "src", "release", "upgrade.ts");
    const script = `
        import { defaultDrainHost } from ${JSON.stringify(upgrade)};
        try {
            console.log("returned " + await defaultDrainHost(${JSON.stringify(operation)}));
        } catch (error) {
            console.log("threw " + (error as Error).message);
        }
    `;
    const ran = Bun.spawnSync([process.execPath, "-e", script], {
        env: { HOME: root, PATH: process.env.PATH ?? "", VERA_HOME: veraHome },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    return ran.stdout.toString().trim();
}

test("a rollback drain refuses a Vera-looking host whose lockfile start time is not a time, without signalling it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-upgrade-badtime-"));
    const veraHome = join(root, "home");
    mkdirSync(join(veraHome, "runtime"), { recursive: true });
    const lockPath = join(veraHome, "runtime", "host.json");
    const host = spawnVeraLookingProcess(root);
    try {
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: host.pid,
            started_at: "not a timestamp",
            socket_path: join(veraHome, "runtime", "host.sock"),
        }));
        expect(drainInSubprocess(root, veraHome, "rollback")).toBe(
            `threw Could not confirm PID ${host.pid} is the Vera host (its lockfile`
                + " has no valid start time); left it running and kept its lockfile."
                + ` Check that PID ${host.pid} is a Vera host before you stop it. If it`
                + ` is not, deleting ${lockPath} is safe.`
                + " Run 'vera rollback' again. Nothing was rolled back.",
        );
        expect(host.signalCode).toBeNull();
        expect(host.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
    } finally {
        host.kill("SIGKILL");
        await host.exited;
        rmSync(root, { recursive: true, force: true });
    }
});

test("a drain clears a lockfile with no valid start time whose PID is not Vera, without signalling it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-upgrade-stale-"));
    const veraHome = join(root, "home");
    mkdirSync(join(veraHome, "runtime"), { recursive: true });
    const lockPath = join(veraHome, "runtime", "host.json");
    const bystander = Bun.spawn(["sleep", "30"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: bystander.pid,
            started_at: "not a timestamp",
            socket_path: join(veraHome, "runtime", "host.sock"),
        }));
        expect(drainInSubprocess(root, veraHome, "install")).toBe("returned absent");
        expect(bystander.signalCode).toBeNull();
        expect(bystander.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(false);
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
        rmSync(root, { recursive: true, force: true });
    }
});

test("a drain refuses a Vera-looking host whose lockfile is missing its socket path, without signalling it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-upgrade-damaged-"));
    const veraHome = join(root, "home");
    mkdirSync(join(veraHome, "runtime"), { recursive: true });
    const lockPath = join(veraHome, "runtime", "host.json");
    const host = spawnVeraLookingProcess(root);
    try {
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 3,
            pid: host.pid,
            started_at: new Date().toISOString(),
            build_id: "vera-abc",
        }));
        expect(drainInSubprocess(root, veraHome, "install")).toBe(
            `threw Could not confirm PID ${host.pid} is the Vera host (its lockfile`
                + " is damaged); left it running and kept its lockfile."
                + ` Check that PID ${host.pid} is a Vera host before you stop it. If it`
                + ` is not, deleting ${lockPath} is safe.`
                + " Run 'bun run install:local' again. The previous release is still active.",
        );
        expect(host.signalCode).toBeNull();
        expect(host.exitCode).toBeNull();
        expect(existsSync(lockPath)).toBe(true);
    } finally {
        host.kill("SIGKILL");
        await host.exited;
        rmSync(root, { recursive: true, force: true });
    }
});

test("a drain refuses a lockfile with no readable PID instead of reporting no host", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-upgrade-unreadable-"));
    const veraHome = join(root, "home");
    mkdirSync(join(veraHome, "runtime"), { recursive: true });
    const lockPath = join(veraHome, "runtime", "host.json");
    try {
        writeFileSync(lockPath, '{ "schema_version": 3, "pid": 51');
        const result = drainInSubprocess(root, veraHome, "rollback");
        expect(result).toStartWith(`threw The host lockfile ${lockPath} exists`);
        expect(result).toContain("cannot tell whether a Vera host is running");
        expect(result).toEndWith("Run 'vera rollback' again. Nothing was rolled back.");
        expect(existsSync(lockPath)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("recoverInterruptedUpgrade starts the new host after an interrupted start", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-recover-new-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        const next = writeDummyRelease(prefix, "vera-new");
        activateRelease(next, prefix);
        writeUpgradeJournal({
            phase: "starting",
            from_build_id: "vera-old",
            to_build_id: "vera-new",
            host_was_running: true,
        }, prefix);
        const started: string[] = [];
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(recovered.recovered).toBe(true);
        expect(recovered.buildId).toBe("vera-new");
        expect(started).toEqual([next]);
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("recoverInterruptedUpgrade starts the previous host after an interrupted drain", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-upgrade-recover-old-"));
    try {
        const previous = writeDummyRelease(prefix, "vera-old");
        activateRelease(previous, prefix);
        writeDummyRelease(prefix, "vera-new");
        writeUpgradeJournal({
            phase: "draining",
            from_build_id: "vera-old",
            to_build_id: "vera-new",
            host_was_running: true,
        }, prefix);
        const started: string[] = [];
        const recovered = await recoverInterruptedUpgrade({
            prefix,
            startHost: async (root) => {
                started.push(root);
            },
        });
        expect(recovered.recovered).toBe(true);
        expect(recovered.buildId).toBe("vera-old");
        expect(started).toEqual([previous]);
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(upgradeJournalPath(prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
