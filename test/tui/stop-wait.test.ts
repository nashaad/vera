import { describe, expect, test } from "bun:test";
import {
    applyStopWaitEvent,
    closeStopWaitCard,
    nextStopWaitCard,
    stopNow,
    stopWaitCardChoice,
    stopWaitCardUpdate,
    stopWaitNoticeText,
    type TuiStopWait,
} from "../../clients/tui/stop-wait.ts";
import type { HostStopWaitEvent } from "../../src/host/protocol.ts";

const waiting = [
    { session_id: "a1", name: "Fix parser", status: "working" as const },
    { session_id: "b2", name: null, status: "queued" as const },
    { session_id: "c3", name: "Docs", status: "waiting" as const },
];

describe("stop-wait state", () => {
    test("a stop wait is kept until it clears", () => {
        const opened: HostStopWaitEvent = {
            type: "host_stop_wait",
            kind: "stop",
            waiting_on: waiting,
        };
        const wait = applyStopWaitEvent(undefined, opened);
        expect(wait).toEqual({ kind: "stop", waitingOn: waiting });
        expect(applyStopWaitEvent(wait, undefined)).toBe(wait);
        expect(applyStopWaitEvent(wait, {
            type: "host_stop_wait_cleared",
            reason: "abandoned",
        })).toBeUndefined();
    });

    test("an update wait carries its target build", () => {
        const wait = applyStopWaitEvent(undefined, {
            type: "host_stop_wait",
            kind: "update",
            target_build_id: "build-42",
            waiting_on: waiting,
        });
        expect(wait).toEqual({
            kind: "update",
            targetBuildId: "build-42",
            waitingOn: waiting,
        });
    });

    test("a restart clears the wait on this side", () => {
        const wait: TuiStopWait = { kind: "stop", waitingOn: waiting };
        expect(applyStopWaitEvent(wait, { type: "host_restarting", build_id: "build-42" }))
            .toBeUndefined();
    });
});

describe("stop-wait notice", () => {
    test("names the first session by name and counts the rest", () => {
        expect(stopWaitNoticeText({ kind: "stop", waitingOn: waiting }))
            .toBe("Stopping · waiting for Fix parser and 2 more");
    });

    test("falls back to the session id when the session has no name", () => {
        expect(stopWaitNoticeText({
            kind: "update",
            targetBuildId: "build-42",
            waitingOn: [waiting[1]!],
        })).toBe("Updating to build-42 · waiting for b2");
    });

    test("is absent when nothing waits", () => {
        expect(stopWaitNoticeText({ kind: "stop", waitingOn: [] })).toBeUndefined();
        expect(stopWaitNoticeText(undefined)).toBeUndefined();
    });
});

describe("stop-now action", () => {
    test("asks the host to cut the waited sessions once and reports no failures", async () => {
        let calls = 0;
        const outcome = await stopNow({
            cut: async () => {
                calls += 1;
                return { type: "cut_stop_wait_done", cut: ["a1", "b2", "c3"], failed: [] };
            },
        });
        expect(calls).toBe(1);
        expect(outcome).toEqual({ kind: "cut", failures: [] });
    });

    test("returns each failed cut with its message and keeps the rest", async () => {
        const outcome = await stopNow({
            cut: async () => ({
                type: "cut_stop_wait_done",
                cut: ["a1", "c3"],
                failed: [{ session_id: "b2", message: "The session did not confirm the cut." }],
            }),
        });
        expect(outcome).toEqual({
            kind: "cut",
            failures: [{ sessionId: "b2", error: "The session did not confirm the cut." }],
        });
    });

    test("a refusal means the wait already ended", async () => {
        expect(await stopNow({
            cut: async () => ({
                type: "cut_stop_wait_refused",
                reason: "no_wait",
                message: "No stop is waiting, so there is nothing to cut.",
            }),
        })).toEqual({ kind: "no_wait" });
    });

    test("a host that cannot cut is reported as unsupported", async () => {
        expect(await stopNow({ cut: async () => ({ type: "unsupported" }) }))
            .toEqual({ kind: "unsupported" });
    });
});
