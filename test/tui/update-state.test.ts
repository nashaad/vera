import { describe, expect, test } from "bun:test";

import type { UpdateOutcome, UpdateProgress } from "../../clients/shared/updates.ts";
import {
    availableFromCheck,
    formatSpan,
    newUpdateRuntime,
    updateCancellable,
    updateNoticeForms,
    updateOutcomeAction,
    updateProgressText,
    type TuiUpdateRun,
    type TuiUpdateRuntime,
} from "../../clients/tui/update-state.ts";

function runtime(overrides: Partial<TuiUpdateRuntime> = {}): TuiUpdateRuntime {
    return { ...newUpdateRuntime("ask"), ...overrides };
}

function run(overrides: Partial<TuiUpdateRun> = {}): TuiUpdateRun {
    return {
        background: false,
        handle: undefined,
        progress: undefined,
        cancelling: false,
        switchAfter: false,
        ...overrides,
    };
}

describe("update notice", () => {
    test("@core available and downloaded checks produce the notice", () => {
        const available = availableFromCheck({
            status: "available",
            currentVersion: "1.0.0",
            currentBuild: "vera-crow-1",
            latestVersion: "1.2.3",
        });
        expect(available).toEqual({ version: "1.2.3", downloaded: false });
        expect(availableFromCheck({
            status: "downloaded",
            currentVersion: "1.0.0",
            currentBuild: "vera-crow-1",
            latestVersion: "1.2.3",
        })).toEqual({ version: "1.2.3", downloaded: true });
        expect(updateNoticeForms(runtime({ available }))).toEqual([
            "update available: Vera 1.2.3 · /update",
            "update available · /update",
            "/update",
        ]);
    });

    test("@core up to date, held and unavailable checks produce no notice", () => {
        for (const status of ["up_to_date", "held", "unavailable"] as const) {
            expect(availableFromCheck({
                status,
                currentVersion: "1.0.0",
                currentBuild: "vera-crow-1",
                latestVersion: "1.2.3",
            })).toBeUndefined();
        }
    });

    test("@core mode off never shows the notice", () => {
        const available = { version: "1.2.3", downloaded: false };
        expect(updateNoticeForms(runtime({ mode: "off", available }))).toEqual([]);
        expect(updateNoticeForms(runtime({ mode: "automatic", available })).length).toBeGreaterThan(0);
        expect(updateNoticeForms(runtime({ mode: "ask", available })).length).toBeGreaterThan(0);
    });

    test("a missing version drops the version form", () => {
        expect(updateNoticeForms(runtime({ available: { version: undefined, downloaded: false } })))
            .toEqual(["update available · /update", "/update"]);
    });

    test("the notice gives way to the progress row while the user's update runs", () => {
        const available = { version: "1.2.3", downloaded: false };
        expect(updateNoticeForms(runtime({ available, run: run() }))).toEqual([]);
        expect(updateNoticeForms(runtime({ available, run: run({ background: true }) })).length).toBe(3);
        expect(updateNoticeForms(undefined)).toEqual([]);
    });
});

describe("update progress row", () => {
    const wide = 200;

    test("each phase has its own wording", () => {
        const phases: readonly [UpdateProgress | undefined, string][] = [
            [undefined, "Updating · checking · Esc cancels"],
            [{ phase: "checking" }, "Updating · checking · Esc cancels"],
            [{ phase: "downloading", bytes: 42, total: 100 }, "Updating · downloading 42% · Esc cancels"],
            [{ phase: "downloading", bytes: 3_355_443 }, "Updating · downloading 3.2 MB · Esc cancels"],
            [{ phase: "switching" }, "Updating · switching"],
        ];
        for (const [progress, expected] of phases) {
            expect(updateProgressText(run({ progress }), wide)).toBe(expected);
        }
    });

    test("waiting names the first session and counts the rest", () => {
        const one: UpdateProgress = {
            phase: "waiting",
            sessions: [{ id: "a1", title: "Fix parser" }],
            waitedMs: 12_000,
            limitMs: 300_000,
        };
        expect(updateProgressText(run({ progress: one }), wide))
            .toBe("Updating · waiting for Fix parser · 12s of 5m · Esc cancels");
        const three: UpdateProgress = {
            ...one,
            sessions: [{ id: "a1", title: "Fix parser" }, { id: "b2", title: "Docs" }, { id: "c3", title: "" }],
            waitedMs: 65_000,
        };
        expect(updateProgressText(run({ progress: three }), wide))
            .toBe("Updating · waiting for Fix parser and 2 more · 1m 5s of 5m · Esc cancels");
    });

    test("a long session name is clipped and an empty title falls back to the id", () => {
        const long = "A".repeat(40);
        const text = updateProgressText(run({
            progress: {
                phase: "waiting",
                sessions: [{ id: "a1", title: long }],
                waitedMs: 0,
                limitMs: 60_000,
            },
        }), wide);
        expect(text).toContain(`${"A".repeat(23)}…`);
        expect(text).not.toContain("A".repeat(24));
        expect(updateProgressText(run({
            progress: { phase: "waiting", sessions: [{ id: "agent-7", title: "" }], waitedMs: 0, limitMs: 60_000 },
        }), wide)).toContain("waiting for agent-7");
    });

    test("a narrow row keeps the cancel hint before the detail", () => {
        const progress: UpdateProgress = {
            phase: "waiting",
            sessions: [{ id: "a1", title: "Fix parser" }],
            waitedMs: 12_000,
            limitMs: 300_000,
        };
        expect(updateProgressText(run({ progress }), 40)).toBe("Updating · waiting · Esc cancels");
        expect(updateProgressText(run({ progress }), 20)).toBe("Updating · Esc cance");
        expect(updateProgressText(run({ progress }), 8)).toBe("Updating");
    });

    test("cancelling and switching show no cancel hint", () => {
        expect(updateProgressText(run({ cancelling: true }), wide)).toBe("Updating · cancelling");
        expect(updateProgressText(run({ progress: { phase: "switching" } }), 10)).toBe("Updating");
    });

    test("a background download shows nothing until the user asks to switch", () => {
        expect(updateProgressText(undefined, wide)).toBeUndefined();
        expect(updateProgressText(run({ background: true }), wide)).toBeUndefined();
        expect(updateProgressText(run({ background: true, switchAfter: true }), wide))
            .toBe("Updating · checking · Esc cancels");
    });

    test("spans read as seconds, minutes and minutes with seconds", () => {
        expect(formatSpan(0)).toBe("0s");
        expect(formatSpan(59_999)).toBe("59s");
        expect(formatSpan(60_000)).toBe("1m");
        expect(formatSpan(125_000)).toBe("2m 5s");
        expect(formatSpan(-5)).toBe("0s");
    });
});

describe("update cancellation", () => {
    test("@core Esc cancels until the switch starts", () => {
        expect(updateCancellable(undefined)).toBe(false);
        expect(updateCancellable(runtime())).toBe(false);
        expect(updateCancellable(runtime({ run: run() }))).toBe(true);
        expect(updateCancellable(runtime({ run: run({ progress: { phase: "downloading", bytes: 1 } }) }))).toBe(true);
        expect(updateCancellable(runtime({ run: run({ progress: { phase: "switching" } }) }))).toBe(false);
        expect(updateCancellable(runtime({ run: run({ cancelling: true }) }))).toBe(false);
    });

    test("a background download is not the user's to cancel until /update joins it", () => {
        expect(updateCancellable(runtime({ run: run({ background: true }) }))).toBe(false);
        expect(updateCancellable(runtime({ run: run({ background: true, switchAfter: true }) }))).toBe(true);
    });
});

describe("update outcome", () => {
    function outcome(overrides: Partial<UpdateOutcome>): UpdateOutcome {
        return { result: "failed", changed: false, ...overrides };
    }

    test("@core done relaunches and every other result is a notice", () => {
        expect(updateOutcomeAction(outcome({ result: "done", changed: true }))).toEqual({ kind: "relaunch" });
        expect(updateOutcomeAction(outcome({ result: "up_to_date" })))
            .toEqual({ kind: "notice", text: "Vera is up to date", error: false });
        expect(updateOutcomeAction(outcome({ result: "cancelled" })))
            .toEqual({ kind: "notice", text: "Update cancelled. Vera was not changed.", error: false });
    });

    test("held and downloaded prefer the message from the update", () => {
        expect(updateOutcomeAction(outcome({ result: "held" })))
            .toEqual({ kind: "notice", text: "This update is held. Vera was not changed.", error: false });
        expect(updateOutcomeAction(outcome({ result: "held", message: "Needs a newer app." })))
            .toEqual({ kind: "notice", text: "Needs a newer app.", error: false });
        expect(updateOutcomeAction(outcome({ result: "downloaded", version: "1.2.3" })))
            .toEqual({ kind: "notice", text: "Vera 1.2.3 is downloaded. Run /update to switch to it.", error: false });
        expect(updateOutcomeAction(outcome({ result: "downloaded" })))
            .toEqual({ kind: "notice", text: "Vera update is downloaded. Run /update to switch to it.", error: false });
    });

    test("@core a failure says what failed and whether Vera changed", () => {
        expect(updateOutcomeAction(outcome({ message: "The download was cut short." })))
            .toEqual({
                kind: "notice",
                text: "Update failed: The download was cut short. Vera was not changed.",
                error: true,
            });
        expect(updateOutcomeAction(outcome({ message: "The app could not be replaced.", changed: true })))
            .toEqual({ kind: "notice", text: "Update failed: The app could not be replaced.", error: true });
        expect(updateOutcomeAction(outcome({})))
            .toEqual({ kind: "notice", text: "Update failed: no reason was given. Vera was not changed.", error: true });
    });
});
