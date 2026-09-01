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
