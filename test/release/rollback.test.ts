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
import { join, resolve } from "node:path";

import { installRelease } from "../../scripts/pack-release.ts";
import { launcherPath } from "../../src/release/layout.ts";
import {
    readUpgradeJournal,
    writeUpgradeJournal,
} from "../../src/release/upgrade.ts";

import { activateRelease } from "../../src/release/activate.ts";
import {
    currentReleaseBuildId,
    currentSymlinkPath,
    releaseDirectory,
    rollbackReleaseBuildId,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import {
    RollbackUnavailableError,
    rollbackLocalInstall,
    supportsRelaunch,
} from "../../src/release/rollback.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";

function writeDummyRelease(prefix: string, buildId: string, script = "echo dummy\n"): string {
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
    writeFileSync(join(root, "vera"), `#!/bin/sh\n${script}`, {
        encoding: "utf8",
        mode: 0o755,
    });
    chmodSync(join(root, "vera"), 0o755);
    return root;
}

interface FakeHost {
    readonly hosts: {
        readonly drainHost: () => Promise<"stopped" | "absent">;
        readonly startHost: (releaseRoot: string) => Promise<void>;
    };
    readonly drains: (string | undefined)[];
    readonly starts: { readonly releaseRoot: string; readonly current: string | undefined }[];
}

function fakeHost(
    prefix: string,
    options: {
        readonly running: boolean;
        readonly failStarts?: number;
        readonly refuseDrain?: string;
    },
): FakeHost {
    const drains: (string | undefined)[] = [];
    const starts: { releaseRoot: string; current: string | undefined }[] = [];
    let failuresLeft = options.failStarts ?? 0;
    return {
        hosts: {
            drainHost: async () => {
                drains.push(currentReleaseBuildId(prefix));
                if (options.refuseDrain !== undefined) {
                    throw new Error(options.refuseDrain);
                }
                return options.running ? "stopped" : "absent";
            },
            startHost: async (releaseRoot: string) => {
                starts.push({ releaseRoot, current: currentReleaseBuildId(prefix) });
                if (failuresLeft > 0) {
                    failuresLeft -= 1;
                    throw new Error("the host did not start");
                }
            },
        },
        drains,
        starts,
    };
}

function installBrokenOverGood(prefix: string): void {
    activateRelease(writeDummyRelease(prefix, "vera-good"), prefix);
    activateRelease(
        writeDummyRelease(prefix, "vera-broken", "echo broken; exit 1\n"),
        prefix,
    );
}

test("relaunch support uses the stamp and recognizes the published alpha", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-capability-"));
    try {
        const manifest = readStampedRelease(writeDummyRelease(prefix, "vera-good"));
        const alpha = { ...manifest, source_revision: "36bf480cef699d760b1080498e561ed199f1a116", build_id: "vera-36bf480" };
        expect(supportsRelaunch(alpha)).toBe(true);
        expect(supportsRelaunch({ ...alpha, build_id: "vera-36bf480+123456789abc" })).toBe(false);
        expect(supportsRelaunch(manifest)).toBe(false);
        expect(supportsRelaunch({ ...manifest, relaunch_record_version: 1 })).toBe(true);
        expect(supportsRelaunch({ ...manifest, relaunch_record_version: 2 })).toBe(false);
        expect(supportsRelaunch({ ...manifest, product_version: "0.1.0-alpha.2" })).toBe(true);
        expect(supportsRelaunch({ ...manifest, product_version: "0.1.0-alpha.0" })).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall restores the pinned previous release", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-"));
    try {
        installBrokenOverGood(prefix);
        expect(currentReleaseBuildId(prefix)).toBe("vera-broken");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-good");

        const host = fakeHost(prefix, { running: false });
        const result = await rollbackLocalInstall(prefix, host.hosts);
        expect(result).toMatchObject({
            kind: "rolled_back",
            toBuildId: "vera-good",
            fromBuildId: "vera-broken",
        });
        expect(readlinkSync(currentSymlinkPath(prefix))).toBe("releases/vera-good");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-broken");
        expect(existsSync(releaseDirectory("vera-broken", prefix))).toBe(true);
        expect(existsSync(releaseDirectory("vera-good", prefix))).toBe(true);
        expect(host.starts).toEqual([]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall stops a running host first and starts the restored release's host", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-host-"));
    try {
        installBrokenOverGood(prefix);
        const host = fakeHost(prefix, { running: true });

        await rollbackLocalInstall(prefix, host.hosts);

        expect(host.drains).toEqual(["vera-broken"]);
        expect(host.starts).toEqual([{
            releaseRoot: releaseDirectory("vera-good", prefix),
            current: "vera-good",
        }]);
        expect(currentReleaseBuildId(prefix)).toBe("vera-good");
        expect(await readUpgradeJournal(prefix)).toBeUndefined();
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall puts the release it left back when the restored host does not start", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-restore-"));
    try {
        installBrokenOverGood(prefix);
        const host = fakeHost(prefix, { running: true, failStarts: 1 });

        await expect(rollbackLocalInstall(prefix, host.hosts)).rejects.toThrow(
            /did not start/,
        );

        expect(currentReleaseBuildId(prefix)).toBe("vera-broken");
        expect(host.starts.map((start) => start.releaseRoot)).toEqual([
            releaseDirectory("vera-good", prefix),
            releaseDirectory("vera-broken", prefix),
        ]);
        expect(await readUpgradeJournal(prefix)).toBeUndefined();
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall changes nothing when the running host cannot be stopped", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-refused-"));
    try {
        installBrokenOverGood(prefix);
        const host = fakeHost(prefix, {
            running: true,
            refuseDrain: "Could not confirm PID 4242",
        });

        await expect(rollbackLocalInstall(prefix, host.hosts)).rejects.toThrow(
            /Could not confirm PID 4242/,
        );

        expect(currentReleaseBuildId(prefix)).toBe("vera-broken");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-good");
        expect(host.starts).toEqual([]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a rollback that finds an interrupted rollback finishes it without rolling back again", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-interrupted-"));
    try {
        installBrokenOverGood(prefix);
        // An earlier rollback switched to vera-good and stopped before its host started.
        activateRelease(releaseDirectory("vera-good", prefix), prefix);
        writeUpgradeJournal({
            phase: "starting",
            from_build_id: "vera-broken",
            to_build_id: "vera-good",
            host_was_running: true,
        }, prefix);
        const host = fakeHost(prefix, { running: true });

        const result = await rollbackLocalInstall(prefix, host.hosts);

        expect(result).toEqual({
            kind: "finished_interrupted",
            prefix,
            activeBuildId: "vera-good",
        });
        expect(currentReleaseBuildId(prefix)).toBe("vera-good");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-broken");
        expect(host.drains).toEqual([]);
        expect(host.starts).toEqual([{
            releaseRoot: releaseDirectory("vera-good", prefix),
            current: "vera-good",
        }]);
        expect(await readUpgradeJournal(prefix)).toBeUndefined();
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("a rollback over a host lockfile whose pid is dead starts no host", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-deadlock-"));
    const home = mkdtempSync(join(tmpdir(), "vera-rollback-home-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        installBrokenOverGood(prefix);
        const exited = Bun.spawn(["true"]);
        await exited.exited;
        const lockPath = join(home, "runtime", "host.json");
        mkdirSync(join(home, "runtime"), { recursive: true });
        writeFileSync(lockPath, JSON.stringify({
            schema_version: 2,
            pid: exited.pid,
            started_at: "2026-08-31T00:00:00.000Z",
            socket_path: join(home, "runtime", "host.sock"),
        }));
        const starts: string[] = [];

        const result = await rollbackLocalInstall(prefix, {
            startHost: async (releaseRoot) => {
                starts.push(releaseRoot);
            },
        });

        expect(result.kind).toBe("rolled_back");
        expect(currentReleaseBuildId(prefix)).toBe("vera-good");
        expect(starts).toEqual([]);
        expect(existsSync(lockPath)).toBe(false);
        expect(await readUpgradeJournal(prefix)).toBeUndefined();
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(prefix, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall refuses when there is no pin", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-empty-"));
    try {
        activateRelease(writeDummyRelease(prefix, "vera-only"), prefix);
        const host = fakeHost(prefix, { running: true });
        await expect(rollbackLocalInstall(prefix, host.hosts)).rejects.toBeInstanceOf(
            RollbackUnavailableError,
        );
        expect(currentReleaseBuildId(prefix)).toBe("vera-only");
        expect(host.drains).toEqual([]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("rollbackLocalInstall refuses a pin whose release is gone", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-rollback-missing-"));
    try {
        installBrokenOverGood(prefix);
        rmSync(releaseDirectory("vera-good", prefix), { recursive: true, force: true });
        const host = fakeHost(prefix, { running: true });
        await expect(rollbackLocalInstall(prefix, host.hosts)).rejects.toThrow(
            /not retained/,
        );
        expect(currentReleaseBuildId(prefix)).toBe("vera-broken");
        expect(host.drains).toEqual([]);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

const repoRoot = resolve(import.meta.dir, "..", "..");
const mainCheckout = resolve(repoRoot, "..", "..");

function sandboxProfile(denied: readonly string[]): string {
    const denies = denied.flatMap((path) => [
        `(deny file-read* (subpath "${path}"))`,
        `(deny file-write* (subpath "${path}"))`,
    ]);
    return `(version 1)\n(allow default)\n(deny network*)\n${denies.join("\n")}\n`;
}

test("vera rollback restores the previous release with the repo and network denied", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "vera-rollback-home-"));
    const prefix = join(userHome, "custom-prefix");
    const scratch = mkdtempSync(join(tmpdir(), "vera-rollback-scratch-"));
    try {
        activateRelease(writeDummyRelease(prefix, "vera-old"), prefix);
        await installRelease({
            prefix,
            cwd: repoRoot,
            sourceRoot: repoRoot,
            force: true,
        });
        expect(currentReleaseBuildId(prefix)).not.toBe("vera-old");
        expect(rollbackReleaseBuildId(prefix)).toBe("vera-old");

        const profilePath = join(scratch, "vera-rollback.sb");
        writeFileSync(profilePath, sandboxProfile([repoRoot, mainCheckout]));
        const pathEnv = [join(prefix, "bin"), "/usr/bin", "/bin"].join(":");
        const blocked = Bun.spawnSync(
            ["sandbox-exec", "-f", profilePath, "/bin/cat", join(repoRoot, "package.json")],
            { cwd: scratch, stdout: "pipe", stderr: "pipe" },
        );
        expect(blocked.exitCode).not.toBe(0);

        const ran = Bun.spawnSync(
            ["sandbox-exec", "-f", profilePath, "vera", "rollback"],
            {
                cwd: scratch,
                env: {
                    HOME: userHome,
                    VERA_HOME: join(scratch, "vera-home"),
                    PATH: pathEnv,
                },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        expect(ran.exitCode, ran.stderr.toString()).toBe(0);
        expect(ran.stdout.toString()).toContain("vera-old");
        expect(currentReleaseBuildId(prefix)).toBe("vera-old");
        expect(existsSync(launcherPath(prefix))).toBe(true);
    } finally {
        rmSync(userHome, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
    }
}, 120_000);
