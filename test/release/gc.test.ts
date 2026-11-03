import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultHostLockPath } from "../../src/host/lockfile.ts";
import { spawnVeraLookingProcess } from "../support/vera-looking-process.ts";

import { gcReleases, ReleaseInUseError, removeRelease } from "../../src/release/gc.ts";
import {
    currentSymlinkPath,
    releaseDirectory,
    rollbackSymlinkPath,
    veraShareRoot,
} from "../../src/release/layout.ts";

function writeRelease(prefix: string, buildId: string): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "vera"), "#!/bin/sh\n");
    return root;
}

function writeCurrent(prefix: string, buildId: string): void {
    mkdirSync(veraShareRoot(prefix), { recursive: true });
    symlinkSync(join("releases", buildId), currentSymlinkPath(prefix));
}

test("removeRelease refuses a referenced activated build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-refuse-"));
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-drop");
        writeCurrent(prefix, "vera-keep");
        expect(() => removeRelease("vera-keep", prefix)).toThrow(ReleaseInUseError);
        expect(existsSync(releaseDirectory("vera-keep", prefix))).toBe(true);
        removeRelease("vera-drop", prefix);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("removeRelease refuses a rollback-protected build", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-rollback-"));
    try {
        writeRelease(prefix, "vera-pin");
        writeRelease(prefix, "vera-drop");
        mkdirSync(veraShareRoot(prefix), { recursive: true });
        symlinkSync(join("releases", "vera-pin"), rollbackSymlinkPath(prefix));
        expect(() => removeRelease("vera-pin", prefix)).toThrow(ReleaseInUseError);
        expect(existsSync(releaseDirectory("vera-pin", prefix))).toBe(true);
        removeRelease("vera-drop", prefix);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases deletes only unreferenced builds", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-sweep-"));
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-drop");
        writeCurrent(prefix, "vera-keep");
        expect(gcReleases(prefix)).toEqual(["vera-drop"]);
        expect(existsSync(releaseDirectory("vera-keep", prefix))).toBe(true);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases leaves a pack's staging and retired directories alone", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-staging-"));
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-drop");
        writeCurrent(prefix, "vera-keep");
        const staging = writeRelease(prefix, ".staging-1-vera-next");
        const retired = writeRelease(prefix, ".retired-1-vera-next");
        expect(gcReleases(prefix)).toEqual(["vera-drop"]);
        expect(existsSync(staging)).toBe(true);
        expect(existsSync(retired)).toBe(true);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases removes nothing while a damaged host lockfile may name a live host", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-damaged-"));
    const lockPath = defaultHostLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `{"schema_version": 3, "socket_pa`);
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-other");
        writeCurrent(prefix, "vera-keep");
        const reasons: string[] = [];
        expect(gcReleases(prefix, { onHeld: (reason) => reasons.push(reason) }))
            .toEqual([]);
        expect(existsSync(releaseDirectory("vera-other", prefix))).toBe(true);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain("damaged");
        expect(reasons[0]).toContain(lockPath);
    } finally {
        rmSync(lockPath, { force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("removeRelease refuses any build while a damaged host lockfile may name a live host", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-damaged-remove-"));
    const lockPath = defaultHostLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `{"schema_version": 3, "socket_pa`);
    try {
        writeRelease(prefix, "vera-other");
        expect(() => removeRelease("vera-other", prefix)).toThrow(
            "The host lockfile is damaged",
        );
        expect(() => removeRelease("vera-other", prefix)).toThrow(ReleaseInUseError);
        expect(existsSync(releaseDirectory("vera-other", prefix))).toBe(true);
    } finally {
        rmSync(lockPath, { force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases and removeRelease keep every release while a live host's lockfile names no build", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-unknown-build-"));
    const directory = mkdtempSync(join(tmpdir(), "vera-gc-unknown-host-"));
    const host = spawnVeraLookingProcess(directory);
    const lockPath = defaultHostLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 2,
        pid: host.pid,
        started_at: new Date().toISOString(),
        socket_path: "/tmp/vera-gc-old.sock",
    })}\n`);
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-other");
        writeCurrent(prefix, "vera-keep");
        const reasons: string[] = [];
        expect(gcReleases(prefix, { onHeld: (reason) => reasons.push(reason) }))
            .toEqual([]);
        expect(existsSync(releaseDirectory("vera-other", prefix))).toBe(true);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain("names no build");
        expect(() => removeRelease("vera-other", prefix)).toThrow(ReleaseInUseError);
        expect(() => removeRelease("vera-other", prefix)).toThrow(
            "The host lockfile names no build",
        );
        expect(existsSync(releaseDirectory("vera-other", prefix))).toBe(true);

        host.kill("SIGKILL");
        await host.exited;
        expect(gcReleases(prefix)).toEqual(["vera-other"]);
    } finally {
        rmSync(lockPath, { force: true });
        host.kill("SIGKILL");
        await host.exited;
        rmSync(directory, { recursive: true, force: true });
        rmSync(prefix, { recursive: true, force: true });
    }
});

/** Runs one reference check in a fresh process, so a ps shim on PATH is honoured. */
function runCheck(
    mode: "hold" | "remove",
    environment: { readonly home: string; readonly veraHome: string; readonly path: string },
    prefix: string,
): string {
    const gc = join(import.meta.dir, "..", "..", "src", "release", "gc.ts");
    const references = join(import.meta.dir, "..", "..", "src", "release", "references.ts");
    const script = mode === "hold"
        ? `
            import { damagedHostLockHold } from ${JSON.stringify(references)};
            console.log(damagedHostLockHold() === undefined ? "free" : "held");
        `
        : `
            import { removeRelease } from ${JSON.stringify(gc)};
            try {
                removeRelease("vera-other", ${JSON.stringify(prefix)});
                console.log("removed");
            } catch (error) {
                console.log((error as Error).name);
            }
        `;
    const ran = Bun.spawnSync([process.execPath, "-e", script], {
        env: {
            HOME: environment.home,
            PATH: environment.path,
            VERA_HOME: environment.veraHome,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    return ran.stdout.toString().trim();
}

test("one removal check reads the process table once, not once per reference question", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-gc-ps-count-"));
    const prefix = join(root, "prefix");
    const veraHome = join(root, "home");
    const host = spawnVeraLookingProcess(root);
    // A ps that logs each call, then runs the real one.
    const realPs = Bun.which("ps");
    if (realPs === null) throw new Error("ps is not on PATH");
    const shims = join(root, "bin");
    const log = join(root, "ps.log");
    mkdirSync(shims, { recursive: true });
    writeFileSync(
        join(shims, "ps"),
        `#!/bin/sh\necho call >> "${log}"\nexec "${realPs}" "$@"\n`,
        { mode: 0o755 },
    );
    const environment = {
        home: root,
        veraHome,
        path: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    function psCalls(run: () => string): { readonly output: string; readonly calls: number } {
        writeFileSync(log, "");
        const output = run();
        const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
        return { output, calls };
    }
    try {
        writeRelease(prefix, "vera-other");
        mkdirSync(join(veraHome, "runtime"), { recursive: true });
        writeFileSync(
            join(veraHome, "runtime", "host.json"),
            `{"schema_version": 3, "pid": ${host.pid}, "started_at": "20`,
        );
        const hold = psCalls(() => runCheck("hold", environment, prefix));
        const removal = psCalls(() => runCheck("remove", environment, prefix));
        expect(hold.output).toBe("held");
        expect(removal.output).toBe("ReleaseInUseError");
        expect(hold.calls).toBeGreaterThan(0);
        expect(removal.calls).toBe(hold.calls);
    } finally {
        host.kill("SIGKILL");
        await host.exited;
        rmSync(root, { recursive: true, force: true });
    }
});
