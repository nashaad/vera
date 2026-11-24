import type { WebContents } from "electron";

import { FindState, type FindCount, type FindResult } from "./state.ts";

export class BrowserFind {
    private target: WebContents | undefined;
    private state: FindState | undefined;
    private query = "";
    private detach: (() => void) | undefined;
    private loading = false;

    constructor(private readonly report: (count: FindCount) => void) {}

    setTarget(contents: WebContents | undefined): void {
        this.release();
        this.report({ current: 0, total: 0 });
        if (!contents || contents.isDestroyed()) return;

        this.target = contents;
        this.loading = contents.isLoadingMainFrame();
        const state = new FindState(contents, this.report);
        this.state = state;
        const isCurrent = () => this.target === contents && this.state === state;
        const found = (_event: Electron.Event, result: FindResult) => {
            if (isCurrent() && !this.loading && !contents.isDestroyed()) state.found(result);
        };
        const navigate = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
            if (!isCurrent() || !isMainFrame || contents.isDestroyed()) return;
            if (isInPlace) {
                state.search(this.query);
            } else {
                this.loading = true;
                state.search("");
            }
        };
        const loaded = () => {
            if (!isCurrent() || !this.loading || contents.isDestroyed()) return;
            this.loading = false;
            state.search(this.query);
        };
        const destroyed = () => {
            if (!isCurrent()) return;
            this.release();
            this.report({ current: 0, total: 0 });
        };
        contents.on("found-in-page", found);
        contents.on("did-start-navigation", navigate);
        contents.on("did-finish-load", loaded);
        contents.on("did-stop-loading", loaded);
        contents.on("destroyed", destroyed);
        this.detach = () => {
            contents.removeListener("found-in-page", found);
            contents.removeListener("did-start-navigation", navigate);
            contents.removeListener("did-finish-load", loaded);
            contents.removeListener("did-stop-loading", loaded);
            contents.removeListener("destroyed", destroyed);
        };
        if (this.query && !this.loading) state.search(this.query);
    }

    search(query: string): void {
        this.query = query;
        if (!this.target || this.target.isDestroyed() || this.loading) {
            this.report({ current: 0, total: 0 });
            return;
        }
        this.state?.search(query);
    }

    move(forward: boolean): void {
        if (!this.loading && this.target && !this.target.isDestroyed()) this.state?.move(forward);
    }

    close(): void {
        this.query = "";
        this.release();
        this.report({ current: 0, total: 0 });
    }

    private release(): void {
        const target = this.target;
        const state = this.state;
        this.target = undefined;
        this.state = undefined;
        this.loading = false;
        this.detach?.();
        this.detach = undefined;
        if (target && !target.isDestroyed()) state?.clear();
    }
}
