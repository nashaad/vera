import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP_RELAUNCH_KEY, DesktopRelaunch, MAX_RELAUNCH_DRAFT_CHARS, decideRelaunch, type RelaunchActions } from "../../clients/desktop/src/relaunch.ts";
import { desktopBuildMismatch } from "../../clients/desktop/src/build-check.ts";
import { INITIAL_STATE, reduceConnection } from "../../clients/ui/src/state/connection.ts";
import { DESKTOP_PACKAGE_MANIFEST_NAME, serializeDesktopPackageManifest } from "../../src/release/desktop-package-manifest.ts";
import { findDesktopPackage, type DesktopPackage } from "../../src/release/desktop-packages.ts";
import {
    clearDesktopShell,
    publishDesktopShell,
    runningDesktopShell,
    type DesktopShellHandle,
} from "../../src/release/desktop-shell.ts";
import { desktopPackageDirectory } from "../../src/release/layout.ts";
import { relaunchRecordPath, takeRelaunchRecord, writeRelaunchRecord } from "../../src/release/relaunch.ts";

const MISMATCH = { clientBuildId: "build-a", installedBuildId: "build-b" };

function shellFor(overrides: Partial<DesktopShellHandle> = {}): DesktopShellHandle {
    return {
        shellApi: 1,
        prefix: "/prefix",
        hostBuildId: "build-a",
        desktopVersion: "1.0.0",
        release: () => {},
        ...overrides,
    };
}

function packageFor(overrides: Partial<DesktopPackage> = {}): DesktopPackage {
    return {
        hostBuildId: "build-b",
        desktopVersion: "1.0.0",
        directory: "/prefix/share/vera/desktop/build-b/1.0.0",
        entryPath: "/prefix/share/vera/desktop/build-b/1.0.0/main.js",
        shellApi: 1,
        ...overrides,
    };
}

test("@core a window under the shell relaunches when a package exists for the installed build", () => {
    const found = packageFor();
    const asked: string[] = [];
    const decision = decideRelaunch(MISMATCH, {
        shell: shellFor(),
        findPackage: (buildId, prefix) => {
            asked.push(`${buildId}@${prefix}`);
            return found;
        },
    });
    expect(decision).toEqual({ kind: "relaunch", package: found });
    expect(asked).toEqual(["build-b@/prefix"]);
});

test("@core a window shows the banner when no package exists for the installed build", () => {
    expect(decideRelaunch(MISMATCH, { shell: shellFor(), findPackage: () => undefined }))
        .toEqual({ kind: "banner", reason: "no_package" });
});

test("@core a window that is not under the shell shows the banner", () => {
    let looked = false;
    const decision = decideRelaunch(MISMATCH, {
        shell: undefined,
        findPackage: () => {
            looked = true;
            return packageFor();
        },
    });
    expect(decision).toEqual({ kind: "banner", reason: "not_under_shell" });
    expect(looked).toBe(false);
});

test("@core a window shows the banner when the package needs a newer shell", () => {
    expect(decideRelaunch(MISMATCH, { shell: shellFor({ shellApi: 1 }), findPackage: () => packageFor({ shellApi: 2 }) }))
        .toEqual({ kind: "banner", reason: "shell_too_old" });
    expect(decideRelaunch(MISMATCH, { shell: shellFor({ shellApi: 2 }), findPackage: () => packageFor({ shellApi: 2 }) }).kind)
        .toBe("relaunch");
});

test("a window never relaunches into the package it already runs", () => {
    const running = shellFor({ hostBuildId: "build-b", desktopVersion: "1.0.0" });
    expect(decideRelaunch(MISMATCH, { shell: running, findPackage: () => packageFor() }))
        .toEqual({ kind: "banner", reason: "same_package" });
    expect(decideRelaunch(MISMATCH, { shell: running, findPackage: () => packageFor({ desktopVersion: "1.1.0" }) }).kind)
        .toBe("relaunch");
});

test("the decision reads the package folder the installer wrote", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-relaunch-packages-"));
    try {
        const placed = desktopPackageDirectory("build-b", "1.0.0", prefix);
        mkdirSync(placed, { recursive: true });
        writeFileSync(join(placed, "main.js"), "// entry\n");
        writeFileSync(join(placed, DESKTOP_PACKAGE_MANIFEST_NAME), serializeDesktopPackageManifest({
            layout_version: 1,
            desktop_version: "1.0.0",
            host_build_id: "build-b",
            entry: "main.js",
            shell_api: 1,
        }));
        const decision = decideRelaunch(MISMATCH, { shell: shellFor({ prefix }), findPackage: findDesktopPackage });
        expect(decision.kind).toBe("relaunch");
        expect(decideRelaunch({ ...MISMATCH, installedBuildId: "build-c" }, { shell: shellFor({ prefix }), findPackage: findDesktopPackage }))
            .toEqual({ kind: "banner", reason: "no_package" });
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

interface Recorded {
    readonly calls: string[];
    readonly records: unknown[];
    readonly actions: RelaunchActions;
}

function recordedActions(overrides: Partial<RelaunchActions> = {}): Recorded {
    const calls: string[] = [];
    const records: unknown[] = [];
    const actions: RelaunchActions = {
        shell: () => shellFor(),
        findPackage: () => packageFor(),
        writeRecord: (record) => {
            calls.push("write");
            records.push(record);
        },
        takeRecord: () => undefined,
        stop: () => calls.push("stop"),
        release: () => calls.push("release"),
        restart: () => calls.push("restart"),
        ...overrides,
    };
    return { calls, records, actions };
}

const NOW = new Date("2026-11-18T10:00:00.000Z");

test("@core a relaunch records the open session, closes the window's connections, releases the hold, then restarts", () => {
    const { calls, records, actions } = recordedActions();
    const relaunch = new DesktopRelaunch(actions, () => NOW);
    relaunch.sessionShown("crow");
    expect(relaunch.buildChanged(MISMATCH)).toBe(true);
    expect(calls).toEqual(["write", "stop", "release", "restart"]);
    expect(records).toEqual([{ sessionId: "crow", writtenAt: NOW.toISOString() }]);
});

test("a relaunch from a page with no session records none", () => {
    const { records, actions } = recordedActions();
    const relaunch = new DesktopRelaunch(actions, () => NOW);
    relaunch.sessionShown("crow");
    relaunch.sessionShown(undefined);
    expect(relaunch.buildChanged(MISMATCH)).toBe(true);
    expect(records).toEqual([{ writtenAt: NOW.toISOString() }]);
});

test("@core a relaunch carries the text the open session's composer holds", () => {
    const { records, actions } = recordedActions();
    const relaunch = new DesktopRelaunch(actions, () => NOW);
    relaunch.sessionShown("crow");
    relaunch.draftChanged("crow", "half a thought");
    expect(relaunch.buildChanged(MISMATCH)).toBe(true);
    expect(records).toEqual([{ sessionId: "crow", draft: { text: "half a thought", attachmentIds: [] }, writtenAt: NOW.toISOString() }]);
});

test("a draft from another session, a blank one or an oversized one is not carried", () => {
    const cases: Array<[string | undefined, string]> = [
        ["finch", "for another session"],
        ["crow", "   \n"],
        ["crow", "x".repeat(MAX_RELAUNCH_DRAFT_CHARS + 1)],
    ];
    for (const [agentId, text] of cases) {
        const { records, actions } = recordedActions();
        const relaunch = new DesktopRelaunch(actions, () => NOW);
        relaunch.sessionShown("crow");
        relaunch.draftChanged(agentId, text);
        relaunch.buildChanged(MISMATCH);
        expect(records).toEqual([{ sessionId: "crow", writtenAt: NOW.toISOString() }]);
    }
});

test("a draft cleared before the relaunch is not carried", () => {
    const { records, actions } = recordedActions();
    const relaunch = new DesktopRelaunch(actions, () => NOW);
    relaunch.sessionShown("crow");
    relaunch.draftChanged("crow", "typed");
    relaunch.draftChanged("crow", "");
    relaunch.buildChanged(MISMATCH);
    expect(records).toEqual([{ sessionId: "crow", writtenAt: NOW.toISOString() }]);
});

test("the next window takes the carried draft with the session, once", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-relaunch-draft-"));
    try {
        const writer = recordedActions({ writeRecord: (record) => writeRelaunchRecord(DESKTOP_RELAUNCH_KEY, record, home) });
        const first = new DesktopRelaunch(writer.actions, () => NOW);
        first.sessionShown("crow");
        first.draftChanged("crow", "half a thought");
        first.buildChanged(MISMATCH);
        const reader = recordedActions({ takeRecord: () => takeRelaunchRecord(DESKTOP_RELAUNCH_KEY, NOW.getTime() + 1_000, home) });
        const next = new DesktopRelaunch(reader.actions);
        expect(next.takeReopen()).toEqual({ agentId: "crow", draft: "half a thought" });
        expect(next.takeReopen()).toBeUndefined();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("a relaunch goes ahead when the record cannot be written", () => {
    const { calls, actions } = recordedActions({
        writeRecord: () => {
            throw new Error("disk full");
        },
    });
    expect(new DesktopRelaunch(actions).buildChanged(MISMATCH)).toBe(true);
    expect(calls).toEqual(["stop", "release", "restart"]);
});

test("@core a banner case leaves the window running and writes nothing", () => {
    for (const overrides of [
        { shell: () => undefined },
        { findPackage: () => undefined },
        { findPackage: () => packageFor({ shellApi: 2 }) },
    ] satisfies Partial<RelaunchActions>[]) {
        const { calls, actions } = recordedActions(overrides);
        expect(new DesktopRelaunch(actions).buildChanged(MISMATCH)).toBe(false);
        expect(calls).toEqual([]);
    }
});

test("@core a newer package for the build the window runs relaunches the window into it", () => {
    const asked: string[] = [];
    const { calls, records, actions } = recordedActions({
        shell: () => shellFor({ desktopVersion: "1.0.0-alpha.2" }),
        findPackage: (buildId) => {
            asked.push(buildId);
            return packageFor({ hostBuildId: "build-a", desktopVersion: "1.0.0-alpha.2.local.1" });
        },
    });
    const relaunch = new DesktopRelaunch(actions, () => NOW);
    relaunch.sessionShown("crow");
    expect(relaunch.packageAdded()).toBe(true);
    expect(asked).toEqual(["build-a"]);
    expect(calls).toEqual(["write", "stop", "release", "restart"]);
    expect(records).toEqual([{ sessionId: "crow", writtenAt: NOW.toISOString() }]);
});

test("the window stays when no newer package it can load exists for its build", () => {
    const running = { desktopVersion: "1.0.0-alpha.2" };
    for (const overrides of [
        { shell: () => undefined },
        { shell: () => shellFor(running), findPackage: () => undefined },
        { shell: () => shellFor(running), findPackage: () => packageFor({ hostBuildId: "build-a", ...running }) },
        { shell: () => shellFor(running), findPackage: () => packageFor({ hostBuildId: "build-a", desktopVersion: "1.0.0-alpha.1" }) },
        { shell: () => shellFor(running), findPackage: () => packageFor({ hostBuildId: "build-a", desktopVersion: "1.0.0", shellApi: 2 }) },
    ] satisfies Partial<RelaunchActions>[]) {
        const { calls, actions } = recordedActions(overrides);
        expect(new DesktopRelaunch(actions).packageAdded()).toBe(false);
        expect(calls).toEqual([]);
    }
});

test("the next window takes the session once", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-relaunch-home-"));
    try {
        const { actions } = recordedActions({
            takeRecord: () => takeRelaunchRecord(DESKTOP_RELAUNCH_KEY, NOW.getTime() + 1_000, home),
        });
        writeRelaunchRecord(DESKTOP_RELAUNCH_KEY, { sessionId: "crow", writtenAt: NOW.toISOString() }, home);
        expect(readFileSync(relaunchRecordPath(DESKTOP_RELAUNCH_KEY, home), "utf8")).toContain("crow");
        const next = new DesktopRelaunch(actions);
        expect(next.takeReopen()).toEqual({ agentId: "crow" });
        expect(next.takeReopen()).toBeUndefined();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("a record older than five minutes opens nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-relaunch-stale-"));
    try {
        writeRelaunchRecord(DESKTOP_RELAUNCH_KEY, { sessionId: "crow", writtenAt: NOW.toISOString() }, home);
        const later = NOW.getTime() + 6 * 60 * 1000;
        expect(new DesktopRelaunch(recordedActions({ takeRecord: () => takeRelaunchRecord(DESKTOP_RELAUNCH_KEY, later, home) }).actions).takeReopen())
            .toBeUndefined();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("@core under the shell the build check runs even when the host boots from source", () => {
    const sources = {
        env: { VERA_DESKTOP_DEV_CLI: "/checkout/clients/cli/main.ts" },
        clientBuildId: () => "build-a",
        installedBuildId: () => "build-b",
    };
    expect(desktopBuildMismatch(sources)).toBeUndefined();
    expect(desktopBuildMismatch({ ...sources, underShell: true })).toEqual(MISMATCH);
});

test("the shell publishes its handle for the package it loads", () => {
    expect(runningDesktopShell()).toBeUndefined();
    const handle = shellFor();
    publishDesktopShell(handle);
    try {
        expect(runningDesktopShell()).toBe(handle);
    } finally {
        clearDesktopShell();
    }
    expect(runningDesktopShell()).toBeUndefined();
});

test("the page reopening a session leaves the connection state as it was", () => {
    expect(reduceConnection(INITIAL_STATE, { type: "event", event: { type: "reopen_session", agentId: "crow" } })).toBe(INITIAL_STATE);
});
