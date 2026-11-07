import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    RELAUNCH_EXIT_CODE,
    RELAUNCH_LAUNCHER_ENV,
    RELAUNCH_RECORD_MAX_AGE_MS,
    launcherKeyFromEnv,
    relaunchRecordPath,
    takeRelaunchRecord,
    writeRelaunchRecord,
} from "../../src/release/relaunch.ts";
import { writeSelfContainedWrappers } from "../../src/release/wrappers.ts";
import { HOST_STARTUP_RACE_EXIT_CODE } from "../../src/host/lockfile.ts";

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
    savedHome = process.env.VERA_HOME;
    home = mkdtempSync(join(tmpdir(), "vera-relaunch-"));
    process.env.VERA_HOME = join(home, "vera");
});

afterEach(() => {
    if (savedHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
});

test("the relaunch code differs from the host startup race code", () => {
    expect(RELAUNCH_EXIT_CODE).toBe(85);
    expect(RELAUNCH_EXIT_CODE).not.toBe(HOST_STARTUP_RACE_EXIT_CODE);
    expect(RELAUNCH_LAUNCHER_ENV).toBe("VERA_TUI_LAUNCHER");
});

test("launcherKeyFromEnv accepts only a numeric pid that is this process's parent", () => {
    expect(launcherKeyFromEnv({ VERA_TUI_LAUNCHER: "4242" }, 4242)).toBe("4242");
    expect(launcherKeyFromEnv({ VERA_TUI_LAUNCHER: "4242" }, 4243)).toBeUndefined();
    expect(launcherKeyFromEnv({ VERA_TUI_LAUNCHER: "" }, 0)).toBeUndefined();
    expect(launcherKeyFromEnv({ VERA_TUI_LAUNCHER: "42/../x" }, 42)).toBeUndefined();
    expect(launcherKeyFromEnv({}, 4242)).toBeUndefined();
});

test("a written record is read once and then removed", () => {
    const now = Date.now();
    writeRelaunchRecord(
        "100",
        {
            sessionId: "agent-1",
            draft: { text: "half typed", attachmentIds: ["a1"] },
            writtenAt: new Date(now).toISOString(),
        },
    );
    const path = relaunchRecordPath("100");
    expect(existsSync(path)).toBe(true);
    expect(takeRelaunchRecord("100", now)).toEqual({
        sessionId: "agent-1",
        draft: { text: "half typed", attachmentIds: ["a1"] },
        writtenAt: new Date(now).toISOString(),
    });
    expect(existsSync(path)).toBe(false);
    expect(takeRelaunchRecord("100", now)).toBeUndefined();
});

test("the record file is private to the user", () => {
    writeRelaunchRecord("101", { writtenAt: new Date().toISOString() });
    expect(statSync(relaunchRecordPath("101")).mode & 0o777).toBe(0o600);
});

test("a record without a session or draft is valid (home screen)", () => {
    const now = Date.now();
    writeRelaunchRecord("102", { writtenAt: new Date(now).toISOString() });
    expect(takeRelaunchRecord("102", now)).toEqual({ writtenAt: new Date(now).toISOString() });
});

test("a stale record is ignored and removed", () => {
    const now = Date.now();
    const old = now - RELAUNCH_RECORD_MAX_AGE_MS - 1000;
    writeRelaunchRecord("103", { sessionId: "agent-old", writtenAt: new Date(old).toISOString() });
    expect(takeRelaunchRecord("103", now)).toBeUndefined();
    expect(existsSync(relaunchRecordPath("103"))).toBe(false);
});

test("a malformed record is ignored and removed", () => {
    const path = relaunchRecordPath("104");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    expect(takeRelaunchRecord("104")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
});

test("a record with a malformed draft is rejected", () => {
    const path = relaunchRecordPath("105");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
        path,
        JSON.stringify({ writtenAt: new Date().toISOString(), draft: { text: 3, attachmentIds: [] } }),
        "utf8",
    );
    expect(takeRelaunchRecord("105")).toBeUndefined();
});

test("records for different launchers do not cross", () => {
    writeRelaunchRecord("200", { sessionId: "one", writtenAt: new Date().toISOString() });
    expect(takeRelaunchRecord("201")).toBeUndefined();
    expect(takeRelaunchRecord("200")?.sessionId).toBe("one");
});

// The launcher loop: a fake bun flips `current` on the first run and exits 75,
// then the second run in the new release exits 0.
test("the launcher relaunches into the release that current points to", () => {
    const share = join(home, "share", "vera");
    const releaseA = join(share, "releases", "A");
    const releaseB = join(share, "releases", "B");
    mkdirSync(releaseA, { recursive: true });
    mkdirSync(releaseB, { recursive: true });
    symlinkSync("releases/A", join(share, "current"));
    writeSelfContainedWrappers(releaseA);
    const log = join(home, "runs.log");
    writeFakeBun(join(releaseA, "bun"), `
echo "A $VERA_TUI_LAUNCHER $PPID" >> "${log}"
rm -f "${join(share, "current")}"
ln -s releases/B "${join(share, "current")}"
exit ${RELAUNCH_EXIT_CODE}
`);
    writeFakeBun(join(releaseB, "bun"), `
echo "B $VERA_TUI_LAUNCHER $PPID" >> "${log}"
exit 0
`);
    const result = runLauncher(join(releaseA, "vera"));
    expect(result.status).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["A", "B"]);
    const keys = lines.map((line) => line.split(" ")[1]);
    expect(keys[0]).toMatch(/^[0-9]+$/);
    expect(keys[1]).toBe(keys[0]);
    // The TUI must see its launcher as its parent, or it will not relaunch.
    const parents = lines.map((line) => line.split(" ")[2]);
    expect(parents).toEqual([keys[0], keys[0]]);
});

test("a stray status 75 from the child ends the loop, it is not a relaunch", () => {
    const share = join(home, "share", "vera");
    const releaseA = join(share, "releases", "A");
    mkdirSync(releaseA, { recursive: true });
    symlinkSync("releases/A", join(share, "current"));
    writeSelfContainedWrappers(releaseA);
    const log = join(home, "runs.log");
    writeFakeBun(join(releaseA, "bun"), `
echo "A" >> "${log}"
exit 75
`);
    const result = runLauncher(join(releaseA, "vera"));
    expect(result.status).toBe(75);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["A"]);
});

test("the launcher passes through any exit status other than the relaunch code", () => {
    const share = join(home, "share", "vera");
    const releaseA = join(share, "releases", "A");
    mkdirSync(releaseA, { recursive: true });
    symlinkSync("releases/A", join(share, "current"));
    writeSelfContainedWrappers(releaseA);
    const log = join(home, "runs.log");
    writeFakeBun(join(releaseA, "bun"), `
echo "A" >> "${log}"
exit 3
`);
    const result = runLauncher(join(releaseA, "vera"));
    expect(result.status).toBe(3);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["A"]);
});

function writeFakeBun(path: string, body: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}`, "utf8");
    chmodSync(path, 0o755);
}

function runLauncher(launcher: string): { status: number | null } {
    const result = spawnSync(launcher, [], { encoding: "utf8", timeout: 10_000 });
    return { status: result.status };
}
