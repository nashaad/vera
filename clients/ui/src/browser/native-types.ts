export const BROWSER_TAB_LIMIT = 12;
export const BROWSER_STATE_CHANGED = "browser.stateChanged";

export interface BrowserTab {
    readonly id: number;
    readonly title: string;
    readonly url: string;
    readonly back: boolean;
    readonly forward: boolean;
}

export interface BrowserHandoffState {
    readonly id: string;
    readonly page: number;
    readonly reason: string;
}

export interface BrowserHandoffAnswer {
    readonly id: string;
    readonly result: "done" | "skipped";
}

export interface BrowserToolsApproval {
    readonly id: string;
    readonly approved: boolean;
}

export interface BrowserToolsAsk {
    readonly id: string;
}

export interface BrowserState {
    readonly tabs: readonly BrowserTab[];
    readonly active: number | null;
    readonly toolsEnabled: boolean;
    readonly toolsAvailable: boolean;
    readonly toolsOffBehavior: "ask" | "refuse";
    readonly handoff?: BrowserHandoffState;
    readonly toolsAsk?: BrowserToolsAsk;
    // The page an "open" command just created, so the caller can bind it to its tab.
    readonly opened?: number;
}

export interface BrowserBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
