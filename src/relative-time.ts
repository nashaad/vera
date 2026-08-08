/**
 * How long ago something happened, for a list a person is scanning.
 *
 * Coarse on purpose: a session list answers "recent or not", so the ladder
 * stops at days rather than growing calendar formatting. Shared because the
 * CLI and the TUI both list sessions, and two copies drifted into two formats
 * once already.
 *
 * `absent` is what to print when there is no usable timestamp, which each
 * caller words for its own surface.
 */
export function relativeTime(
    value: string | undefined,
    now: Date,
    absent: string,
): string {
    const timestamp = value === undefined ? Number.NaN : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return absent;
    }
    const elapsedMinutes = Math.max(
        0,
        Math.floor((now.getTime() - timestamp) / 60_000),
    );
    if (elapsedMinutes < 1) {
        return "just now";
    }
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes}m ago`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours}h ago`;
    }
    return `${Math.floor(elapsedHours / 24)}d ago`;
}
