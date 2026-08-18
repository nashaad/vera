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
    if (maxScrollTop === 0) {
        return true;
    }
    // Scrolled fully up is a deliberate position, never the live edge. Without
    // this the tolerance swallows a one-row scroll range whole and sticky
    // scroll drags the reader back down.
    if (scrollTop <= 0) {
        return false;
    }
    return scrollTop >= maxScrollTop - 1;
}
