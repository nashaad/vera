export function tuiTranscriptAtBottom(
    scrollTop: number,
    scrollHeight: number,
    viewportHeight: number,
): boolean {
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    if (maxScrollTop === 0) {
        return true;
    }
    if (scrollTop <= 0) {
        return false;
    }
    return scrollTop >= maxScrollTop - 1;
}
