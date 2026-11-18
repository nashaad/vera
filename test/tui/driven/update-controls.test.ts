import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    shouldCheckNow,
    UPDATE_CHECK_INTERVAL_MS,
    type UpdateCheck,
    type UpdateMode,
    type UpdateOutcome,
    type UpdateProgress,
} from "../../../clients/shared/updates.ts";
import type { TuiDependencies } from "../../../clients/tui/main.ts";
import type { TuiRelaunchRequest } from "../../../clients/tui/restart-notice.ts";
import type { TuiUpdateDependencies } from "../../../clients/tui/update-state.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const home = () => mkdtempSync(join(tmpdir(), "vera-update-controls-"));

const AVAILABLE: UpdateCheck = {
    status: "available",
    currentVersion: "1.0.0",
    currentBuild: "vera-crow-1",
    latestVersion: "1.2.3",
};

interface FakeRun {
    readonly downloadOnly: boolean;
    cancels: number;
    progress(value: UpdateProgress): void;
    finish(outcome: UpdateOutcome): void;
}

interface FakeUpdates {
    readonly updates: TuiUpdateDependencies;
    readonly runs: FakeRun[];
    checks: number;
    mode: UpdateMode;
    check: UpdateCheck;
    clock: number;
}

function fakeUpdates(initial: { mode?: UpdateMode; check?: UpdateCheck; tickMs?: number } = {}): FakeUpdates {
    const fake: FakeUpdates = {
        runs: [],
        checks: 0,
        mode: initial.mode ?? "ask",
        check: initial.check ?? AVAILABLE,
        clock: 0,
        updates: undefined as unknown as TuiUpdateDependencies,
    };
    const updates: TuiUpdateDependencies = {
        mode: () => fake.mode,
        check: async () => {
            fake.checks += 1;
            return fake.check;
        },
        run: (downloadOnly, onProgress) => {
            let switching = false;
            let finish: (outcome: UpdateOutcome) => void = () => undefined;
            const done = new Promise<UpdateOutcome>((resolve) => { finish = resolve; });
            const record: FakeRun = {
                downloadOnly,
                cancels: 0,
                progress(value) {
                    if (value.phase === "switching") switching = true;
                    onProgress(value);
                },
                finish,
            };
            fake.runs.push(record);
            return {
                cancel() {
                    if (switching) return false;
                    record.cancels += 1;
                    finish({ result: "cancelled", changed: false });
                    return true;
                },
                done,
            };
        },
        shouldCheckNow,
        now: () => fake.clock,
        tickMs: initial.tickMs ?? 3_600_000,
    };
    return Object.assign(fake, { updates });
}

function client() {
    return createSettingsAnsweringClient({
        agentId: "crow-session",
        model: "fixture",
        mode: "auto",
        initialUpdates: [{ type: "history", entries: [{ kind: "assistant", text: "Crow voyage" }], seq: 0 }],
    });
}

function dependencies(
    fake: FakeUpdates | undefined,
    extra: Partial<TuiDependencies> = {},
): TuiDependencies {
    return {
        client: client(),
        ...(fake === undefined ? {} : { updates: fake.updates }),
        ...extra,
    };
}

async function until(predicate: () => boolean, description: string, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await Bun.sleep(20);
    }
}

async function startUpdateRun(session: Awaited<ReturnType<typeof startTuiTestSession>>, fake: FakeUpdates) {
    await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
    session.sendText("/update");
    await session.waitForVisiblePane("Update Vera");
    session.sendKey("Enter");
    await until(() => fake.runs.length === 1, "the update to start");
    return fake.runs[0]!;
}

test("@core the footer offers the update when a newer version is available", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const pane = await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
        expect(pane).not.toContain("ready");
        expect(fake.checks).toBe(1);
        expect(fake.runs).toHaveLength(0);
    } finally { await session.close(); }
}, 15_000);

test("a downloaded update offers the same notice", async () => {
    const fake = fakeUpdates({ check: { ...AVAILABLE, status: "downloaded" } });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
    } finally { await session.close(); }
}, 15_000);

test("@core mode off neither checks nor shows the notice", async () => {
    const fake = fakeUpdates({ mode: "off", tickMs: 30 });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await session.waitForVisiblePane("ready");
        fake.clock += UPDATE_CHECK_INTERVAL_MS * 2;
        await session.settle(300);
        expect(fake.checks).toBe(0);
        expect(session.captureVisiblePane()).not.toContain("update available");
    } finally { await session.close(); }
}, 15_000);

test("an up to date, held or unavailable check shows no notice", async () => {
    for (const status of ["up_to_date", "held", "unavailable"] as const) {
        const fake = fakeUpdates({ check: { ...AVAILABLE, status } });
        const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
        try {
            await session.waitForVisiblePane("ready");
            await until(() => fake.checks === 1, "the check");
            await session.settle(200);
            expect(session.captureVisiblePane()).not.toContain("update available");
        } finally { await session.close(); }
    }
}, 30_000);

test("@core the check repeats every six hours and not before", async () => {
    const fake = fakeUpdates({ check: { ...AVAILABLE, status: "up_to_date" }, tickMs: 25 });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await until(() => fake.checks === 1, "the first check");
        fake.clock = UPDATE_CHECK_INTERVAL_MS - 1;
        await session.settle(200);
        expect(fake.checks).toBe(1);
        fake.clock = UPDATE_CHECK_INTERVAL_MS;
        await until(() => fake.checks === 2, "the second check");
        await session.settle(200);
        expect(fake.checks).toBe(2);
    } finally { await session.close(); }
}, 15_000);

test("turning the mode off clears the notice and turning it on again checks again", async () => {
    const fake = fakeUpdates({ tickMs: 25 });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
        fake.mode = "off";
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("update available"), "the notice to clear");
        fake.clock = UPDATE_CHECK_INTERVAL_MS;
        await session.settle(200);
        expect(fake.checks).toBe(1);
        fake.mode = "ask";
        await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
        expect(fake.checks).toBe(2);
    } finally { await session.close(); }
}, 15_000);

test("a narrow footer keeps a shorter form of the notice", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 56, height: 30, dependencies: () => dependencies(fake) });
    try {
        const pane = await session.waitForVisiblePaneWhere((text) => text.includes("/update"), "the short notice");
        expect(pane).not.toContain("Vera 1.2.3");
    } finally { await session.close(); }
}, 15_000);

test("@core /update shows each phase above the composer and Esc cancels before the switch", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const run = await startUpdateRun(session, fake);
        expect(run.downloadOnly).toBe(false);
        await session.waitForVisiblePane("Updating · checking · Esc cancels");
        expect(session.captureVisiblePane()).not.toContain("update available");

        run.progress({ phase: "downloading", bytes: 42, total: 100 });
        await session.waitForVisiblePane("Updating · downloading 42% · Esc cancels");

        run.progress({
            phase: "waiting",
            sessions: [{ id: "a1", title: "Fix parser" }, { id: "b2", title: "Docs" }],
            waitedMs: 12_000,
            limitMs: 300_000,
        });
        await session.waitForVisiblePane("Updating · waiting for Fix parser and 1 more · 12s of 5m · Esc cancels");

        session.sendText("a draft in progress");
        await session.waitForVisiblePane("a draft in progress");
        session.sendKey("Escape");
        await until(() => run.cancels === 1, "the cancel");
        await session.waitForVisiblePane("Update cancelled. Vera was not changed.");
        expect(session.captureVisiblePane()).not.toContain("Updating ·");
        expect(session.captureVisiblePane()).toContain("a draft in progress");
        await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
    } finally { await session.close(); }
}, 20_000);

test("@core Esc does not cancel once the switch has started", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const run = await startUpdateRun(session, fake);
        run.progress({ phase: "switching" });
        const pane = await session.waitForVisiblePane("Updating · switching");
        expect(pane).not.toContain("Esc cancels");
        session.sendText("a draft to keep");
        await session.waitForVisiblePane("a draft to keep");
        session.sendKey("Escape");
        await session.settle(200);
        expect(run.cancels).toBe(0);
        const after = session.captureVisiblePane();
        expect(after).toContain("Updating · switching");
        expect(after).toContain("a draft to keep");
    } finally { await session.close(); }
}, 15_000);

test("@core a finished update relaunches with the conversation and the draft", async () => {
    const fake = fakeUpdates();
    const relaunches: TuiRelaunchRequest[] = [];
    const session = await startTuiTestSession({
        home: home(),
        width: 140,
        height: 30,
        dependencies: () => dependencies(fake, {
            relaunchTui: async (request) => { relaunches.push(request); },
        }),
    });
    try {
        const run = await startUpdateRun(session, fake);
        session.sendText("keep this draft");
        await session.waitForVisiblePane("keep this draft");
        run.progress({ phase: "switching" });
        run.finish({ result: "done", version: "1.2.3", build: "vera-kraken-2", changed: true });
        await session.waitForVisiblePane("Restarting to match");
        await until(() => relaunches.length === 1, "the relaunch");
        expect(relaunches[0]?.sessionId).toBe("crow-session");
        expect(relaunches[0]?.draft?.text).toBe("keep this draft");
        await session.settle(300);
        expect(relaunches).toHaveLength(1);
    } finally { await session.close(); }
}, 20_000);

test("a finished update without a launcher shows the installed-build message", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({
        home: home(),
        width: 140,
        height: 30,
        dependencies: () => dependencies(fake, {
            clientBuildId: "vera-crow-1",
            installedBuildId: () => "vera-kraken-2",
        }),
    });
    try {
        const run = await startUpdateRun(session, fake);
        run.finish({ result: "done", version: "1.2.3", build: "vera-kraken-2", changed: true });
        const pane = await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        expect(pane).toContain("this TUI is build vera-crow-1");
    } finally { await session.close(); }
}, 15_000);

test("a finished update with no build to compare still says to reopen Vera", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const run = await startUpdateRun(session, fake);
        run.finish({ result: "done", changed: true });
        await session.waitForVisiblePane("Vera is updated. Quit and reopen Vera to continue.");
    } finally { await session.close(); }
}, 15_000);

test("@core a failed update reports why and that Vera was not changed", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const run = await startUpdateRun(session, fake);
        run.finish({ result: "failed", message: "The download was cut short.", changed: false });
        await session.waitForVisiblePane("Update failed: The download was cut short. Vera was not changed.");
        expect(session.captureVisiblePane()).not.toContain("Updating ·");
    } finally { await session.close(); }
}, 15_000);

test("a held update says so and the notice stays", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const run = await startUpdateRun(session, fake);
        run.finish({ result: "held", message: "This update needs a newer Vera app.", changed: false });
        await session.waitForVisiblePane("This update needs a newer Vera app.");
    } finally { await session.close(); }
}, 15_000);

test("a second /update while one runs says Vera is already updating", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await startUpdateRun(session, fake);
        session.sendText("/update");
        await session.waitForVisiblePane("Update Vera");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Vera is already updating");
        expect(fake.runs).toHaveLength(1);
    } finally { await session.close(); }
}, 15_000);

test("@core automatic mode downloads in the background and /update then switches", async () => {
    const fake = fakeUpdates({ mode: "automatic" });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await session.waitForVisiblePane("update available: Vera 1.2.3 · /update");
        await until(() => fake.runs.length === 1, "the background download");
        const download = fake.runs[0]!;
        expect(download.downloadOnly).toBe(true);
        download.progress({ phase: "downloading", bytes: 10, total: 100 });
        await session.settle(200);
        const quiet = session.captureVisiblePane();
        expect(quiet).not.toContain("Updating ·");
        expect(quiet).toContain("update available: Vera 1.2.3 · /update");

        download.finish({ result: "downloaded", version: "1.2.3", changed: false });
        await session.settle(200);
        expect(fake.runs).toHaveLength(1);
        expect(session.captureVisiblePane()).not.toContain("Vera 1.2.3 is downloaded");

        session.sendText("/update");
        await session.waitForVisiblePane("Update Vera");
        session.sendKey("Enter");
        await until(() => fake.runs.length === 2, "the switch");
        expect(fake.runs[1]?.downloadOnly).toBe(false);
        await session.waitForVisiblePane("Updating · checking · Esc cancels");
    } finally { await session.close(); }
}, 20_000);

test("/update during the background download joins it and switches when it ends", async () => {
    const fake = fakeUpdates({ mode: "automatic" });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await until(() => fake.runs.length === 1, "the background download");
        const download = fake.runs[0]!;
        session.sendText("/update");
        await session.waitForVisiblePane("Update Vera");
        session.sendKey("Enter");
        download.progress({ phase: "downloading", bytes: 50, total: 100 });
        await session.waitForVisiblePane("Updating · downloading 50% · Esc cancels");
        expect(fake.runs).toHaveLength(1);

        download.finish({ result: "downloaded", version: "1.2.3", changed: false });
        await until(() => fake.runs.length === 2, "the switch after the download");
        expect(fake.runs[1]?.downloadOnly).toBe(false);
    } finally { await session.close(); }
}, 20_000);

test("/update runs in mode off, and the notice stays hidden", async () => {
    const fake = fakeUpdates({ mode: "off" });
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        await session.waitForVisiblePane("ready");
        session.sendText("/update");
        await session.waitForVisiblePane("Update Vera");
        session.sendKey("Enter");
        await until(() => fake.runs.length === 1, "the update to start");
        expect(fake.runs[0]?.downloadOnly).toBe(false);
        expect(fake.checks).toBe(0);
    } finally { await session.close(); }
}, 15_000);

test("a source checkout has nothing to update", async () => {
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(undefined) });
    try {
        await session.waitForVisiblePane("ready");
        session.sendText("/update");
        await session.waitForVisiblePane("Update Vera");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This Vera runs from a source checkout, so there is nothing to update here.");
        expect(session.captureVisiblePane()).not.toContain("update available");
    } finally { await session.close(); }
}, 15_000);

test("@core quitting cancels an update that has not started switching", async () => {
    const fake = fakeUpdates();
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30, dependencies: () => dependencies(fake) });
    try {
        const run = await startUpdateRun(session, fake);
        run.progress({ phase: "downloading", bytes: 1, total: 100 });
        await session.waitForVisiblePane("Updating · downloading 1% · Esc cancels");
        session.sendKey("C-c");
        session.sendKey("C-c");
        await session.waitForSessionExit();
        expect(run.cancels).toBe(1);
    } finally { await session.close(); }
}, 20_000);
