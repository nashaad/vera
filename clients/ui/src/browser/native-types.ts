export const BROWSER_TAB_LIMIT = 12;

export interface BrowserTab {
    readonly id: number;
    readonly title: string;
    readonly url: string;
    readonly back: boolean;
    readonly forward: boolean;
}

export interface BrowserState {
    readonly tabs: readonly BrowserTab[];
    readonly active: number | null;
    readonly toolsEnabled: boolean;
    readonly toolsAvailable: boolean;
}

export interface BrowserBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
