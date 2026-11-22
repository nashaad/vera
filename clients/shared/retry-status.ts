// Retry facts both clients render: which attempt, how long until it starts or
// how long it has been silent, and a short label for the last failure.

export interface RetryStatusFacts {
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    // Epoch ms of the next attempt; absent when the client could not read one.
    readonly retryAt?: number;
    readonly failureKind: string;
    readonly statusCode?: number;
}

export interface RetryStatus {
    readonly state: "waiting" | "in_flight";
    readonly attempt: number;
    readonly maxAttempts: number;
    // Time left before the next attempt, while waiting.
    readonly delayMs?: number;
    // Time since the attempt began, while in flight; absent without a retryAt.
    readonly silenceMs?: number;
    readonly failure: string;
}

// now equal to retryAt means the attempt has started, so the silence shows.
export function retryStatus(facts: RetryStatusFacts, now: number): RetryStatus {
    const retryAt = facts.retryAt !== undefined && Number.isFinite(facts.retryAt)
        ? facts.retryAt
        : undefined;
    const waiting = retryAt !== undefined && now < retryAt;
    return {
        state: waiting ? "waiting" : "in_flight",
        attempt: facts.nextAttempt,
        maxAttempts: facts.maxAttempts,
        failure: retryFailureLabel(facts.failureKind, facts.statusCode),
        ...(waiting
            ? { delayMs: Math.max(0, retryAt - now) }
            : retryAt === undefined
            ? {}
            : { silenceMs: Math.max(0, now - retryAt) }),
    };
}

// "8s", "1m20s", "12m04s": the compact form both status lines use.
export function retryDurationText(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    return seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

// A countdown never reads "in 0s": a sub-second wait reads "<1s".
export function retryDelayText(milliseconds: number): string {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0s";
    if (milliseconds < 1_000) return "<1s";
    return retryDurationText(milliseconds);
}

const FAILURE_LABELS: Readonly<Record<string, string>> = {
    connection: "network error",
    timeout: "timed out",
    rate_limit: "rate limited",
    overloaded: "overloaded",
    server: "server error",
    authentication: "auth error",
    payment_required: "billing",
    permission: "no access",
    invalid_request: "bad request",
    request_build: "request error",
    not_found: "not found",
    request_too_large: "too large",
};

// A server failure knows its HTTP status, which says more than "server error".
export function retryFailureLabel(kind: string, statusCode?: number): string {
    if (kind === "server" && statusCode !== undefined) return String(statusCode);
    return FAILURE_LABELS[kind] ?? "request failed";
}
