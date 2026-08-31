/**
 * Stops a turn that the automatic approval reviewer keeps denying.
 *
 * Denials go back to the model rather than to the user, so nothing else would
 * notice an agent looping on a variation of the same rejected action. The
 * counters and thresholds mirror `GuardianRejectionCircuitBreaker` in
 * openai/codex (Apache-2.0), `codex-rs/core/src/guardian/mod.rs`.
 */

/** Denials in a row. A run this long is an agent retrying, not exploring. */
export const MAX_CONSECUTIVE_REVIEW_DENIALS_PER_TURN = 3;

/** Denials inside the recent window, for a turn that alternates. */
export const MAX_RECENT_REVIEW_DENIALS_PER_TURN = 10;

/** How many recent reviews the window holds. */
export const REVIEW_DENIAL_WINDOW_SIZE = 50;

export interface ReviewCircuitBreaker {
    /**
     * Records one reviewed decision. Returns the interrupt reason when the
     * turn has to stop, or `undefined` to keep going.
     *
     * Reviews that never produced a verdict are not recorded: a provider
     * outage is not the agent misbehaving.
     */
    record(decision: "allow" | "deny"): string | undefined;
}

export function createReviewCircuitBreaker(): ReviewCircuitBreaker {
    let consecutiveDenials = 0;
    const recent: ("allow" | "deny")[] = [];
    return {
        record(decision) {
            recent.push(decision);
            if (recent.length > REVIEW_DENIAL_WINDOW_SIZE) {
                recent.shift();
            }
            if (decision === "allow") {
                consecutiveDenials = 0;
                return undefined;
            }
            consecutiveDenials += 1;
            if (consecutiveDenials >= MAX_CONSECUTIVE_REVIEW_DENIALS_PER_TURN) {
                return `The approval classifier denied ${consecutiveDenials} actions in a row,`
                    + " so the turn was stopped. Say what you want to happen next.";
            }
            const denials = recent.filter((entry) => entry === "deny").length;
            if (denials >= MAX_RECENT_REVIEW_DENIALS_PER_TURN) {
                return `The approval classifier denied ${denials} of the last`
                    + ` ${recent.length} actions, so the turn was stopped.`
                    + " Say what you want to happen next.";
            }
            return undefined;
        },
    };
}
