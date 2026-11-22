import { describe, expect, test } from "bun:test";

import {
    retryDelayText,
    retryDurationText,
    retryFailureLabel,
    retryStatus,
} from "../../clients/shared/retry-status.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

describe("retryStatus", () => {
    test("before retryAt the attempt is waiting with the time left", () => {
        expect(retryStatus({
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW + 8_000,
            failureKind: "connection",
        }, NOW)).toEqual({
            state: "waiting",
            attempt: 3,
            maxAttempts: 7,
            delayMs: 8_000,
            failure: "network error",
        });
    });

    test("at retryAt and after it the attempt is in flight with its silence", () => {
        const facts = {
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW,
            failureKind: "connection",
        };
        expect(retryStatus(facts, NOW)).toEqual({
            state: "in_flight",
            attempt: 3,
            maxAttempts: 7,
            silenceMs: 0,
            failure: "network error",
        });
        expect(retryStatus(facts, NOW + 80_000).silenceMs).toBe(80_000);
    });

    test("an attempt without a readable retryAt is in flight with no silence", () => {
        const status = retryStatus({
            nextAttempt: 3,
            maxAttempts: 7,
            failureKind: "connection",
        }, NOW);
        expect(status.state).toBe("in_flight");
        expect(status.silenceMs).toBeUndefined();
    });

    test("an unknown failure kind still has a label", () => {
        expect(retryFailureLabel("something_new")).toBe("request failed");
    });

    test("a server failure shows its status code", () => {
        expect(retryFailureLabel("server", 503)).toBe("503");
        expect(retryFailureLabel("server")).toBe("server error");
        expect(retryStatus({
            nextAttempt: 2,
            maxAttempts: 7,
            retryAt: NOW + 1_000,
            failureKind: "server",
            statusCode: 503,
        }, NOW).failure).toBe("503");
    });

    test("common failure kinds keep their short labels", () => {
        expect(retryFailureLabel("connection")).toBe("network error");
        expect(retryFailureLabel("timeout")).toBe("timed out");
        expect(retryFailureLabel("rate_limit")).toBe("rate limited");
        expect(retryFailureLabel("overloaded")).toBe("overloaded");
        expect(retryFailureLabel("authentication")).toBe("auth error");
    });
});

describe("retryDurationText", () => {
    test("seconds, then minutes and padded seconds", () => {
        expect(retryDurationText(8_000)).toBe("8s");
        expect(retryDurationText(80_000)).toBe("1m20s");
        expect(retryDurationText(724_000)).toBe("12m04s");
        expect(retryDurationText(0)).toBe("0s");
    });
});

describe("retryDelayText", () => {
    test("a sub-second wait reads <1s so the countdown never reads in 0s", () => {
        expect(retryDelayText(400)).toBe("<1s");
        expect(retryDelayText(1_000)).toBe("1s");
        expect(retryDelayText(1_100)).toBe("1s");
        expect(retryDelayText(8_900)).toBe("8s");
        expect(retryDelayText(0)).toBe("0s");
    });
});
