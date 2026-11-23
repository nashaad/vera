import { sessionCount, type AgentListFacts } from "../protocol/client.ts";
import {
    SESSIONS_PAGE_SIZE,
    canShowMoreSessions,
    loadSessionTailPage,
    mergeSessionRows,
    sessionRows,
    type SessionRow,
} from "../protocol/sessions.ts";

export interface SessionPageUpdate {
    readonly count: number | undefined;
    readonly rows: readonly SessionRow[];
    readonly nextCursor?: string;
}

export type ListSessionPage = (cursor: string) => Promise<AgentListFacts>;

export class SessionPager {
    private firstPage: readonly SessionRow[] = [];
    private tail: readonly SessionRow[] = [];
    private nextCursor: string | undefined;
    private total: number | undefined;
    private busy = false;
    private restoring = false;
    private owner = 0;

    applyFirstPage(list: AgentListFacts): SessionPageUpdate {
        this.firstPage = sessionRows(list);
        this.total = sessionCount(list);
        if (this.tail.length === 0 || this.restoring) this.nextCursor = list.next_cursor;
        return this.update();
    }

    async loadMore(list: ListSessionPage): Promise<SessionPageUpdate | undefined> {
        if (this.busy || this.nextCursor === undefined) return undefined;
        this.busy = true;
        const owner = ++this.owner;
        try {
            const result = await loadSessionTailPage(
                this.firstPage,
                this.tail,
                this.nextCursor,
                Math.ceil((this.total ?? Number.MAX_SAFE_INTEGER) / SESSIONS_PAGE_SIZE),
                list,
            );
            if (owner !== this.owner) return undefined;
            this.tail = result.rows;
            this.nextCursor = result.nextCursor;
            return this.update();
        } finally {
            if (owner === this.owner) this.busy = false;
        }
    }

    async restoreTail(
        firstPage: () => Promise<AgentListFacts>,
        list: ListSessionPage,
        targetLength: number,
        onUpdate: (update: SessionPageUpdate) => void = () => {},
    ): Promise<SessionPageUpdate | undefined> {
        if (this.busy) return undefined;
        this.busy = true;
        this.restoring = true;
        const owner = ++this.owner;
        try {
            const page = await firstPage();
            if (owner !== this.owner) return undefined;
            this.firstPage = sessionRows(page);
            this.total = sessionCount(page);
            this.nextCursor = page.next_cursor;
            onUpdate(this.update());
            const firstPageRows = this.firstPage;
            const total = this.total;
            const firstPageCursor = page.next_cursor;
            const result = await loadSessionTailPage(
                firstPageRows,
                [],
                firstPageCursor,
                Math.ceil((total ?? targetLength) / SESSIONS_PAGE_SIZE),
                list,
                targetLength,
            );
            if (owner !== this.owner) return undefined;
            this.tail = result.rows;
            this.nextCursor = result.nextCursor;
            const update = this.update();
            onUpdate(update);
            return update;
        } finally {
            if (owner === this.owner) {
                this.busy = false;
                this.restoring = false;
            }
        }
    }

    invalidate(): void {
        this.owner += 1;
        this.busy = false;
        this.restoring = false;
    }

    reset(): void {
        this.invalidate();
        this.firstPage = [];
        this.tail = [];
        this.nextCursor = undefined;
        this.total = undefined;
    }

    get tailLength(): number {
        return this.tail.length;
    }

    get isBusy(): boolean {
        return this.busy;
    }

    get isRestoring(): boolean {
        return this.restoring;
    }

    get canShowMore(): boolean {
        return canShowMoreSessions(this.total, mergeSessionRows(this.firstPage, this.tail).length, this.nextCursor);
    }

    private update(): SessionPageUpdate {
        return {
            count: this.total,
            rows: mergeSessionRows(this.firstPage, this.tail),
            ...(this.nextCursor === undefined ? {} : { nextCursor: this.nextCursor }),
        };
    }
}

