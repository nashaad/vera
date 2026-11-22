import {
    retryDelayText,
    retryDurationText,
    retryStatus,
    type RetryStatusFacts,
} from "../shared/retry-status.ts";
import type { ModelActivityUpdate } from "../../src/engine/protocol.ts";

export interface TuiRetryLine {
    readonly text: string;
    // Shorter forms of the same line, tried in order when the footer is tight.
    readonly alternates: readonly string[];
}

// The footer's retry line. The caller supplies the turn clock it already draws,
// so the line ticks on the existing status refresh.
export function tuiRetryLine(
    facts: RetryStatusFacts,
    elapsed: string,
    now: number,
): TuiRetryLine {
    const status = retryStatus(facts, now);
    const attempt = status.state === "waiting"
        ? `retrying ${status.attempt}/${status.maxAttempts} in ${retryDelayText(status.delayMs ?? 0)}`
        : `retrying ${status.attempt}/${status.maxAttempts}`;
    const timing = status.silenceMs === undefined
        ? []
        : [`no reply ${retryDurationText(status.silenceMs)}`];
    const head = [attempt, ...timing];
    // The failure label gives way first, before the attempt or the clock.
    return {
        text: [...head, status.failure, elapsed].join(" · "),
        alternates: [[...head, elapsed].join(" · ")],
    };
}

// A retryAt the client cannot read leaves the attempt in flight with no silence.
export function tuiRetryLineFromActivity(
    activity: ModelActivityUpdate,
    elapsed: string,
    now: number,
): TuiRetryLine {
    const retryAt = Date.parse(activity.retryAt);
    return tuiRetryLine({
        nextAttempt: activity.nextAttempt,
        maxAttempts: activity.maxAttempts,
        ...(Number.isFinite(retryAt) ? { retryAt } : {}),
        failureKind: activity.failure.kind,
        ...(activity.failure.statusCode === undefined
            ? {}
            : { statusCode: activity.failure.statusCode }),
    }, elapsed, now);
}
