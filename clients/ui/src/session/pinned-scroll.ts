const PINNED_SLACK_PX = 48;

export interface ScrollPosition {
    scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
}

export class PinnedScrollState {
    private pinned = true;
    private lastTop = 0;
    private lastHeight = 0;

    resized(element: ScrollPosition): void {
        if (this.pinned) element.scrollTop = element.scrollHeight;
    }

    scrolled(element: ScrollPosition): void {
        // A height change can move the viewport without the reader scrolling.
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK_PX;
        if (nearBottom) this.pinned = true;
        else if (element.scrollTop < this.lastTop && element.scrollHeight === this.lastHeight) this.pinned = false;
        this.lastTop = element.scrollTop;
        this.lastHeight = element.scrollHeight;
    }

    preservePosition(element: ScrollPosition): void {
        this.pinned = false;
        this.lastTop = element.scrollTop;
        this.lastHeight = element.scrollHeight;
    }
}
