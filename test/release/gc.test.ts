import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    readFileSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { copySleep } from "../support/copied-sleep.ts";

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

test("gcReleases retains links, three newest by build time, and processes from any home", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-sweep-"));
    try {
        for (const [index, name] of ["current", "rollback", "running", "drop", "new1", "new2", "new3"].entries()) {
            const release = writeRelease(prefix, `vera-${name}`);
            utimesSync(release, index + 1, index + 1);
        }
        writeFileSync(join(releaseDirectory("vera-new1", prefix), "manifest.json"), JSON.stringify({ built_at: "2030-01-01T00:00:00Z" }));
        writeCurrent(prefix, "vera-current");
        symlinkSync(releaseDirectory("vera-rollback", prefix), rollbackSymlinkPath(prefix));
        expect(gcReleases(prefix, { listProcessExecutables: () => [join(releaseDirectory("vera-running", prefix), "vera-bin")] })).toEqual(["vera-drop"]);
        expect(existsSync(releaseDirectory("vera-drop", prefix))).toBe(false);
        for (const name of ["current", "rollback", "running", "new1", "new2", "new3"]) {
            expect(existsSync(releaseDirectory(`vera-${name}`, prefix))).toBe(true);
        }
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases leaves a pack's staging and retired directories alone", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-staging-"));
    try {
        writeRelease(prefix, "vera-keep");
        writeRelease(prefix, "vera-drop");
        for (const [index, name] of ["vera-new-1", "vera-new-2", "vera-new-3"].entries()) {
            const release = writeRelease(prefix, name);
            utimesSync(release, 100 + index, 100 + index);
        }
        utimesSync(releaseDirectory("vera-keep", prefix), 2, 2);
        utimesSync(releaseDirectory("vera-drop", prefix), 1, 1);
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

test("gcReleases keeps every release when the first process scan fails", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-first-scan-fail-"));
    try {
        for (const name of ["old", "one", "two", "three"]) writeRelease(prefix, `vera-${name}`);
        const old = releaseDirectory("vera-old", prefix);
        utimesSync(old, 1, 1);
        const reasons: string[] = [];
        expect(gcReleases(prefix, {
            onHeld: (reason) => reasons.push(reason),
            listProcessExecutables: () => { throw new Error("Cannot inspect running processes"); },
        })).toEqual([]);
        expect(existsSync(old)).toBe(true);
        expect(reasons).toHaveLength(1);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases restores a renamed release when the second process scan fails", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-scan-fail-"));
    try {
        for (const name of ["old", "one", "two", "three"]) writeRelease(prefix, `vera-${name}`);
        utimesSync(releaseDirectory("vera-old", prefix), 1, 1);
        const reasons: string[] = [];
        let calls = 0;
        expect(gcReleases(prefix, {
            onHeld: (reason) => reasons.push(reason),
            listProcessExecutables: () => {
                if (++calls > 1) throw new Error("Cannot inspect running processes");
                return [];
            },
        })).toEqual([]);
        expect(existsSync(releaseDirectory("vera-old", prefix))).toBe(true);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain("Cannot inspect running processes");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases restores a release that appears in the second process scan", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-gc-race-"));
    try {
        const old = writeRelease(prefix, "vera-old");
        for (const name of ["one", "two", "three"]) writeRelease(prefix, `vera-${name}`);
        utimesSync(old, 1, 1);
        let calls = 0;
        expect(gcReleases(prefix, { listProcessExecutables: () => ++calls === 1 ? [] : [join(dirname(old), `.gc-vera-old-${process.pid}`, "vera-bin")] })).toEqual([]);
        expect(existsSync(old)).toBe(true);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("gcReleases keeps a real running executable through a symlinked prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-gc-real-"));
    const physical = join(root, "physical");
    const prefix = join(root, "link");
    mkdirSync(physical);
    symlinkSync(physical, prefix);
    const running = writeRelease(prefix, "vera-running");
    const executable = join(running, "vera-bin");
    copySleep(executable);
    const child = Bun.spawn([executable, "60"], { stdout: "ignore", stderr: "ignore" });
    try {
        const drop = writeRelease(prefix, "vera-drop");
        for (const name of ["one", "two", "three"]) writeRelease(prefix, `vera-${name}`);
        utimesSync(running, 1, 1);
        utimesSync(drop, 2, 2);
        await Bun.sleep(100);
        expect(child.exitCode).toBeNull();
        expect(gcReleases(prefix)).toEqual(["vera-drop"]);
        expect(existsSync(running)).toBe(true);
        expect(existsSync(drop)).toBe(false);
    } finally {
        child.kill();
        await child.exited;
        rmSync(root, { recursive: true, force: true });
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
        expect(gcReleases(prefix, { onHeld: (reason) => reasons.push(reason) })).toEqual([]);
        expect(existsSync(releaseDirectory("vera-other", prefix))).toBe(true);
        expect(() => removeRelease("vera-other", prefix)).toThrow(ReleaseInUseError);
        expect(() => removeRelease("vera-other", prefix)).toThrow(
            "The host lockfile names no build",
        );
        expect(existsSync(releaseDirectory("vera-other", prefix))).toBe(true);

        host.kill("SIGKILL");
        await host.exited;
        expect(gcReleases(prefix)).toEqual([]);
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
