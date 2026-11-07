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
    test("aborts every waited-on session in order", async () => {
        const aborted: string[] = [];
        const results = await stopNow(
            { kind: "stop", waitingOn: waiting },
            {
                abort: async (sessionId) => {
                    aborted.push(sessionId);
                },
            },
        );
        expect(aborted).toEqual(["a1", "b2", "c3"]);
        expect(results.every((result) => result.error === undefined)).toBe(true);
    });

    test("a failed abort is reported and the rest still run", async () => {
        const aborted: string[] = [];
        const results = await stopNow(
            { kind: "stop", waitingOn: waiting },
            {
                abort: async (sessionId) => {
                    if (sessionId === "b2") throw new Error("socket closed");
                    aborted.push(sessionId);
                },
            },
        );
        expect(aborted).toEqual(["a1", "c3"]);
        expect(results).toEqual([
            { sessionId: "a1" },
            { sessionId: "b2", error: "socket closed" },
            { sessionId: "c3" },
        ]);
    });
});

describe("stop-wait card", () => {
    const plain: TuiStopWait = { kind: "stop", waitingOn: waiting };
    const update: TuiStopWait = {
        kind: "update",
        targetBuildId: "build-42",
        waitingOn: waiting,
    };

    test("opens once per wait and stays closed after it is answered", () => {
        const opened = nextStopWaitCard(undefined, plain);
        expect(opened).toEqual({ key: "stop", open: true });
        const answered = closeStopWaitCard(opened!);
        expect(nextStopWaitCard(answered, plain)).toBe(answered);
    });

    test("a changed session list keeps a closed card closed", () => {
        const closed = closeStopWaitCard(nextStopWaitCard(undefined, update)!);
        const changed: TuiStopWait = { ...update, waitingOn: [waiting[0]!] };
        expect(nextStopWaitCard(closed, changed)).toEqual(closed);
    });

    test("a new wait opens the card again, and a cleared wait removes it", () => {
        const closed = closeStopWaitCard(nextStopWaitCard(undefined, plain)!);
        expect(nextStopWaitCard(closed, update)).toEqual({ key: "update:build-42", open: true });
        expect(nextStopWaitCard(closed, undefined)).toBeUndefined();
    });

    test("the card offers keep waiting first and by default, then stop it now", () => {
        const card = stopWaitCardUpdate(update, { key: "update:build-42", open: true });
        expect(card?.request.question).toBe("Updating to build-42. Waiting for Fix parser.");
        expect(card?.request.choices.map((choice) => choice.label)).toEqual([
            "Keep waiting",
            "Stop it now",
        ]);
        expect(card?.request.choices[0]?.recommended).toBe(true);
        expect(stopWaitCardUpdate(plain, { key: "stop", open: false })).toBeUndefined();
        expect(stopWaitCardUpdate(plain, { key: "stop", open: true })?.request.question)
            .toBe("Vera is stopping. Waiting for Fix parser.");
    });

    test("only Stop it now answers stop; keep, escape and cancel answer keep", () => {
        const selected = (choiceId: string) => ({
            type: "ui_response" as const,
            requestId: "tui-local:stop-wait",
            response: { type: "user_question" as const, outcome: "selected" as const, choiceId },
        });
        expect(stopWaitCardChoice(selected("stop"))).toBe("stop");
        expect(stopWaitCardChoice(selected("keep"))).toBe("keep");
        expect(stopWaitCardChoice({
            type: "ui_response",
            requestId: "tui-local:stop-wait",
            response: { type: "user_question", outcome: "cancelled" },
        })).toBe("keep");
    });
});
