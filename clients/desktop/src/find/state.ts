export interface FindResult {
    readonly requestId: number;
    readonly matches: number;
    readonly activeMatchOrdinal: number;
    readonly finalUpdate: boolean;
}

export interface FindCount {
    readonly current: number;
    readonly total: number;
}

export interface FindTarget {
    findInPage(text: string, options: { readonly forward: boolean; readonly findNext: boolean }): number;
    stopFindInPage(action: "clearSelection"): void;
}

export class FindState {
    private query = "";
    private requestId: number | undefined;

    constructor(
        private readonly target: FindTarget,
        private readonly report: (count: FindCount) => void,
    ) {}

    search(query: string): void {
        this.query = query;
        this.requestId = undefined;
        if (query === "") {
            this.target.stopFindInPage("clearSelection");
            this.report({ current: 0, total: 0 });
            return;
        }
        this.report({ current: 0, total: 0 });
        this.requestId = this.target.findInPage(query, { forward: true, findNext: true });
    }

    move(forward: boolean): void {
        if (this.query === "") return;
        this.requestId = this.target.findInPage(this.query, { forward, findNext: false });
    }

    found(result: FindResult): void {
        if (!result.finalUpdate || result.requestId !== this.requestId) return;
        const total = Math.max(0, result.matches);
        const current = total === 0 ? 0 : Math.max(0, Math.min(result.activeMatchOrdinal, total));
        this.report({ current, total });
    }

    clear(): void {
        this.query = "";
        this.requestId = undefined;
        this.target.stopFindInPage("clearSelection");
        this.report({ current: 0, total: 0 });
    }
}
