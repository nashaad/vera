/**
 * Treat the last scroll row as the live edge. Wheel events can stop one row
 * short of the exact maximum, but that position is visually indistinguishable
 * from the bottom and should re-engage sticky transcript scrolling.
 */
export function tuiTranscriptAtBottom(
    scrollTop: number,
    scrollHeight: number,
    viewportHeight: number,
): boolean {
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    return scrollTop >= Math.max(0, maxScrollTop - 1);
}
