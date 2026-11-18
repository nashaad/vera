import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readUpdateMode, UPDATE_CHECK_INTERVAL_MS, writeUpdateMode, type UpdateProgress } from "../../clients/shared/updates.ts";
import { resolveUpdateCommand } from "../../clients/desktop/src/vera-command.ts";
import { runUpdateTask, type UpdateApi } from "../../clients/desktop/src/update/run-task.ts";
import {
    encodeUpdateProgress,
    parseUpdateProgress,
    parseUpdateTask,
    parseUpdateTaskReply,
    type UpdateTask,
    type UpdateTaskReply,
} from "../../clients/desktop/src/update/task-protocol.ts";
import { parseUpdateAction } from "../../clients/ui/src/protocol/updates.ts";

const scratch: string[] = [];

afterEach(() => {
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function folder(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-update-task-"));
    scratch.push(directory);
    return directory;
}

const roundTrip = <Value>(value: Value): unknown => JSON.parse(JSON.stringify(structuredClone(value)));

const TASKS: readonly UpdateTask[] = [
    { kind: "check", home: "/home", now: 5, force: false },
    { kind: "check", home: "/home", now: 5, force: true, command: "/prefix/bin/vera", lastCheckedAt: 1 },
    { kind: "mode", home: "/home" },
    { kind: "mode", home: "/home", mode: "automatic" },
    { kind: "run", command: "/prefix/bin/vera", downloadOnly: true },
];

const REPLIES: readonly UpdateTaskReply[] = [
    { kind: "check", mode: "ask", intervalMs: UPDATE_CHECK_INTERVAL_MS },
    { kind: "check", mode: "automatic", intervalMs: 1000, check: { status: "available", currentVersion: "1.0.0", latestVersion: "1.1.0", message: "m" } },
    { kind: "mode", mode: "off" },
    { kind: "mode", mode: "ask", problem: "config.json could not be read" },
    { kind: "run", answer: { result: "done", changed: true, version: "1.1.0" } },
    { kind: "run", answer: { result: "failed", changed: false, message: "The download stopped." } },
];

const PROGRESS: readonly UpdateProgress[] = [
    { phase: "checking" },
    { phase: "downloading", bytes: 5 },
    { phase: "downloading", bytes: 5, total: 10 },
    { phase: "waiting", sessions: [{ id: "crow", title: "Fix the build" }], waitedMs: 1, limitMs: 2 },
    { phase: "switching" },
];

test("@core every task, reply and progress line survives a structured clone and JSON unchanged", () => {
    for (const task of TASKS) {
        expect(parseUpdateTask(roundTrip(task))).toEqual(task);
        expect(parseUpdateTask(task)).toEqual(task);
    }
    for (const reply of REPLIES) {
        expect(parseUpdateTaskReply(roundTrip(reply))).toEqual(reply);
    }
    for (const progress of PROGRESS) {
        expect(parseUpdateProgress(encodeUpdateProgress(progress))).toEqual(progress);
    }
});

test("@core malformed tasks are refused", () => {
    const bad: unknown[] = [
        undefined,
        null,
        "check",
        [],
        {},
        { kind: "other" },
        { kind: "check", home: "/home", now: 1 },
        { kind: "check", home: "", now: 1, force: false },
        { kind: "check", home: "/home", now: -1, force: false },
        { kind: "check", home: "/home", now: Number.NaN, force: false },
        { kind: "check", home: "/home", now: 1, force: false, command: 3 },
        { kind: "check", home: "/home", now: 1, force: false, command: "" },
        { kind: "check", home: "/home", now: 1, force: false, lastCheckedAt: "soon" },
        { kind: "mode", home: "/home", mode: "sometimes" },
        { kind: "mode", mode: "off" },
        { kind: "run", command: "/prefix/bin/vera" },
        { kind: "run", downloadOnly: true },
        { kind: "run", command: "x".repeat(2001), downloadOnly: false },
    ];
    for (const value of bad) expect(parseUpdateTask(value)).toBeUndefined();
});

test("@core malformed replies and progress lines are refused", () => {
    const badReplies: unknown[] = [
        undefined,
        {},
        { kind: "check", mode: "ask" },
        { kind: "check", mode: "maybe", intervalMs: 1 },
        { kind: "check", mode: "ask", intervalMs: -1 },
        { kind: "check", mode: "ask", intervalMs: 1, check: { status: "gone", currentVersion: "1" } },
        { kind: "check", mode: "ask", intervalMs: 1, check: { status: "available" } },
        { kind: "mode", mode: "ask", problem: 4 },
        { kind: "run" },
        { kind: "run", answer: { result: "done" } },
        { kind: "run", answer: { result: "mixed", changed: true } },
        { kind: "run", answer: { result: "done", changed: true, version: 2 } },
    ];
    for (const value of badReplies) expect(parseUpdateTaskReply(value)).toBeUndefined();
    const badProgress: Array<string | undefined> = [
        undefined,
        "",
        "not json",
        "[]",
        JSON.stringify({ phase: "baking" }),
        JSON.stringify({ phase: "downloading" }),
        JSON.stringify({ phase: "downloading", bytes: -1 }),
        JSON.stringify({ phase: "downloading", bytes: 1, total: "a lot" }),
        JSON.stringify({ phase: "waiting", sessions: "crow", waitedMs: 1, limitMs: 2 }),
        JSON.stringify({ phase: "waiting", sessions: [{ id: "crow" }], waitedMs: 1, limitMs: 2 }),
        JSON.stringify({ phase: "waiting", sessions: [], waitedMs: 1 }),
    ];
    for (const value of badProgress) expect(parseUpdateProgress(value)).toBeUndefined();
});

test("a waiting line lists at most fifty sessions and long text is cut", () => {
    const sessions = Array.from({ length: 80 }, (_, index) => ({ id: `s${index}`, title: "t".repeat(5000) }));
    const parsed = parseUpdateProgress(JSON.stringify({ phase: "waiting", sessions, waitedMs: 1, limitMs: 2 }));
    expect(parsed?.phase === "waiting" ? parsed.sessions.length : 0).toBe(50);
    expect(parsed?.phase === "waiting" ? parsed.sessions[0]?.title.length : 0).toBe(2000);
});

test("the window's update actions are checked", () => {
    for (const kind of ["check", "run", "cancel", "dismiss"] as const) expect(parseUpdateAction({ kind })).toEqual({ kind });
    expect(parseUpdateAction({ kind: "mode", mode: "automatic" })).toEqual({ kind: "mode", mode: "automatic" });
    for (const value of [undefined, null, "run", [], {}, { kind: "mode" }, { kind: "mode", mode: "sometimes" }, { kind: "reboot" }]) {
        expect(parseUpdateAction(value)).toBeUndefined();
    }
});

interface Calls {
    readonly checks: string[];
    readonly runs: Array<{ command: string; downloadOnly: boolean | undefined }>;
    cancels: number;
}

function fakeApi(over: Partial<UpdateApi> = {}): { api: UpdateApi; calls: Calls } {
    const calls: Calls = { checks: [], runs: [], cancels: 0 };
    const api: UpdateApi = {
        readMode: () => "ask",
        writeMode: () => undefined,
        check: async (options) => {
            calls.checks.push(options.veraCommand);
            return { status: "available", currentVersion: "1.0.0", currentBuild: "abc", latestVersion: "1.1.0" };
        },
        run: (options, onProgress) => {
            calls.runs.push({ command: options.veraCommand, downloadOnly: options.downloadOnly });
            onProgress({ phase: "checking" });
            return {
                cancel: () => {
                    calls.cancels += 1;
                    return true;
                },
                done: Promise.resolve({ result: "done", changed: true, version: "1.1.0", build: "def" }),
            };
        },
        due: () => true,
        ...over,
    };
    return { api, calls };
}

interface Report {
    readonly progress: Array<string | undefined>;
    readonly cancelListeners: Array<() => void>;
    readonly report: Parameters<typeof runUpdateTask>[1];
}

function fakeReport(): Report {
    const progress: Array<string | undefined> = [];
    const cancelListeners: Array<() => void> = [];
    return {
        progress,
        cancelListeners,
        report: { progress: (message) => progress.push(message), log: () => undefined, onCancel: (listener) => cancelListeners.push(listener) },
    };
}

test("@core a check task asks the command only when the mode allows it and a check is due", async () => {
    const { api, calls } = fakeApi();
    const task: UpdateTask = { kind: "check", home: "/home", now: 9, force: false, command: "/prefix/bin/vera" };
    expect(await runUpdateTask(task, fakeReport().report, api)).toEqual({
        kind: "check",
        mode: "ask",
        intervalMs: UPDATE_CHECK_INTERVAL_MS,
        check: { status: "available", currentVersion: "1.0.0", latestVersion: "1.1.0" },
    });
    expect(calls.checks).toEqual(["/prefix/bin/vera"]);

    const notDue = fakeApi({ due: () => false });
    expect(await runUpdateTask(task, fakeReport().report, notDue.api)).toEqual({ kind: "check", mode: "ask", intervalMs: UPDATE_CHECK_INTERVAL_MS });
    expect(await runUpdateTask({ ...task, force: true }, fakeReport().report, notDue.api)).toMatchObject({ check: { status: "available" } });

    const off = fakeApi({ readMode: () => "off" });
    expect(await runUpdateTask({ ...task, force: true }, fakeReport().report, off.api)).toEqual({ kind: "check", mode: "off", intervalMs: UPDATE_CHECK_INTERVAL_MS });
    expect(off.calls.checks).toEqual([]);

    const noCommand = fakeApi();
    const { command: _dropped, ...withoutCommand } = task;
    expect(await runUpdateTask(withoutCommand, fakeReport().report, noCommand.api)).toEqual({ kind: "check", mode: "ask", intervalMs: UPDATE_CHECK_INTERVAL_MS });
    expect(noCommand.calls.checks).toEqual([]);
});

test("@core a run task relays progress, answers once, and cancels the command when told", async () => {
    const { api, calls } = fakeApi();
    const { report, progress, cancelListeners } = fakeReport();
    const reply = await runUpdateTask({ kind: "run", command: "/prefix/bin/vera", downloadOnly: true }, report, api);
    expect(reply).toEqual({ kind: "run", answer: { result: "done", changed: true, version: "1.1.0" } });
    expect(calls.runs).toEqual([{ command: "/prefix/bin/vera", downloadOnly: true }]);
    expect(progress.map(parseUpdateProgress)).toEqual([{ phase: "checking" }]);
    expect(cancelListeners).toHaveLength(1);
    cancelListeners[0]?.();
    expect(calls.cancels).toBe(1);
});

test("a mode task writes the mode and reads it back, and says why when it could not write", async () => {
    let stored: "ask" | "automatic" | "off" = "ask";
    const writable = fakeApi({ readMode: () => stored, writeMode: (_home, mode) => { stored = mode; } });
    expect(await runUpdateTask({ kind: "mode", home: "/home", mode: "off" }, fakeReport().report, writable.api)).toEqual({ kind: "mode", mode: "off" });
    expect(await runUpdateTask({ kind: "mode", home: "/home" }, fakeReport().report, writable.api)).toEqual({ kind: "mode", mode: "off" });
    const refusing = fakeApi({ writeMode: () => { throw new Error("config.json is not valid JSON"); } });
    expect(await runUpdateTask({ kind: "mode", home: "/home", mode: "off" }, fakeReport().report, refusing.api)).toEqual({
        kind: "mode",
        mode: "ask",
        problem: "config.json is not valid JSON",
    });
});

test("@core the mode is kept in the home's config.json beside the other keys, and a home with no config starts one", async () => {
    const home = folder();
    expect(readUpdateMode(home)).toBe("ask");
    await runUpdateTask({ kind: "mode", home, mode: "automatic" }, fakeReport().report);
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(readUpdateMode(home)).toBe("automatic");

    const kept = folder();
    writeFileSync(join(kept, "config.json"), JSON.stringify({ approval_mode: "ask", providers: { crow: { base_url: "http://x" } }, updates: { other: 1 } }));
    expect(await runUpdateTask({ kind: "mode", home: kept, mode: "off" }, fakeReport().report)).toEqual({ kind: "mode", mode: "off" });
    const written = JSON.parse(readFileSync(join(kept, "config.json"), "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ approval_mode: "ask", providers: { crow: { base_url: "http://x" } }, updates: { other: 1, mode: "off" } });
    expect(readdirSync(kept)).toEqual(["config.json"]);

    const broken = folder();
    writeFileSync(join(broken, "config.json"), "{ not json");
    const reply = await runUpdateTask({ kind: "mode", home: broken, mode: "off" }, fakeReport().report);
    expect(reply).toMatchObject({ kind: "mode", mode: "ask" });
    expect(reply.kind === "mode" ? reply.problem : undefined).toContain("config.json");
    expect(readFileSync(join(broken, "config.json"), "utf8")).toBe("{ not json");
});

test("@core the update command is the named one, else the installed launcher, and none from source", () => {
    const directory = folder();
    const launcher = join(directory, "vera");
    const named = join(directory, "fake-vera");
    for (const path of [launcher, named]) {
        writeFileSync(path, "#!/bin/sh\n");
        chmodSync(path, 0o755);
    }
    const plain = join(directory, "plain");
    writeFileSync(plain, "x");
    mkdirSync(join(directory, "empty"));

    expect(resolveUpdateCommand({}, launcher)).toBe(launcher);
    expect(resolveUpdateCommand({}, join(directory, "missing"))).toBeUndefined();
    expect(resolveUpdateCommand({ VERA_DESKTOP_UPDATE_COMMAND: named }, launcher)).toBe(named);
    expect(resolveUpdateCommand({ VERA_DESKTOP_UPDATE_COMMAND: plain }, launcher)).toBeUndefined();
    expect(resolveUpdateCommand({ VERA_DESKTOP_UPDATE_COMMAND: "  " }, launcher)).toBe(launcher);
    expect(resolveUpdateCommand({ VERA_DESKTOP_DEV_CLI: "/checkout/cli.ts" }, launcher)).toBeUndefined();
    expect(resolveUpdateCommand({ VERA_DESKTOP_DEV_CLI: "/checkout/cli.ts", VERA_DESKTOP_UPDATE_COMMAND: named }, launcher)).toBe(named);
});
