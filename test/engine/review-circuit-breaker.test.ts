import { expect, test } from "bun:test";

import {
    createReviewCircuitBreaker,
    MAX_RECENT_REVIEW_DENIALS_PER_TURN,
    REVIEW_DENIAL_WINDOW_SIZE,
} from "../../src/engine/review-circuit-breaker.ts";

test("three denials in a row stop the turn", () => {
    const breaker = createReviewCircuitBreaker();

    expect(breaker.record("deny")).toBeUndefined();
    expect(breaker.record("deny")).toBeUndefined();
    expect(breaker.record("deny")).toContain("3 actions in a row");
});

test("an allow clears the consecutive run", () => {
    const breaker = createReviewCircuitBreaker();

    breaker.record("deny");
    breaker.record("deny");
    breaker.record("allow");

    expect(breaker.record("deny")).toBeUndefined();
    expect(breaker.record("deny")).toBeUndefined();
    expect(breaker.record("deny")).toContain("3 actions in a row");
});

test("a turn that alternates still trips on the recent window", () => {
    const breaker = createReviewCircuitBreaker();
    let interrupt: string | undefined;
    let denials = 0;

    // Never two denials in a row, so only the window can catch this.
    while (interrupt === undefined && denials < REVIEW_DENIAL_WINDOW_SIZE) {
        breaker.record("allow");
        denials += 1;
        interrupt = breaker.record("deny");
    }

    expect(denials).toBe(MAX_RECENT_REVIEW_DENIALS_PER_TURN);
    expect(interrupt).toContain(`denied ${MAX_RECENT_REVIEW_DENIALS_PER_TURN}`);
});

test("denials that fall out of the window stop counting", () => {
    const breaker = createReviewCircuitBreaker();

    // Nine denials, then enough allows to push them all out of the window.
    for (let index = 0; index < MAX_RECENT_REVIEW_DENIALS_PER_TURN - 1; index += 1) {
        breaker.record("deny");
        breaker.record("allow");
    }
    for (let index = 0; index < REVIEW_DENIAL_WINDOW_SIZE; index += 1) {
        expect(breaker.record("allow")).toBeUndefined();
    }

    expect(breaker.record("deny")).toBeUndefined();
});
