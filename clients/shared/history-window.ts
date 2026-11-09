import type {
    HistoryPageInfo,
    HistoryUpdate,
    TranscriptEntry,
} from "../../src/engine/protocol.ts";

export const HISTORY_PAGE_VERSION = 1;

/** The stored transcript the client has loaded, oldest first. Live rows stay out. */
export interface HistoryWindow {
    readonly entries: readonly TranscriptEntry[];
    readonly hasEarlier: boolean;
    readonly olderBefore?: string;
    readonly headId?: string;
}

export const EMPTY_HISTORY_WINDOW: HistoryWindow = {
    entries: [],
    hasEarlier: false,
};

export type HistoryWindowMergeKind = "replace" | "keep" | "append" | "prepend" | "advance";

export interface HistoryWindowMerge {
    readonly window: HistoryWindow;
    readonly kind: HistoryWindowMergeKind;
}

export interface HistoryPageSlice {
    readonly before: string;
    readonly entries: readonly TranscriptEntry[];
    readonly page: HistoryPageInfo;
}

export interface HistoryUserPrompt {
    readonly text: string;
    readonly attachmentIds?: readonly string[];
}

export function entryId(entry: TranscriptEntry): string | undefined {
    return "id" in entry ? entry.id : undefined;
}

export function historyUserTexts(
    entries: readonly TranscriptEntry[],
): readonly string[] {
    return entries.flatMap((entry) =>
        entry.kind === "user" ? [entry.text] : []
    );
}

export function historyUserPrompts(entries: readonly TranscriptEntry[]): readonly HistoryUserPrompt[] {
    return entries.flatMap((entry) => entry.kind === "user" ? [{
        text: entry.text,
        ...(entry.attachments === undefined
            ? {}
            : { attachmentIds: entry.attachments.map((attachment) => attachment.id) }),
    }] : []);
}

function windowFromPage(
    entries: readonly TranscriptEntry[],
    page: HistoryPageInfo,
): HistoryWindow {
    return {
        entries,
        hasEarlier: page.hasMore && page.olderBefore !== undefined,
        ...(page.olderBefore === undefined ? {} : { olderBefore: page.olderBefore }),
        ...(page.headId === undefined ? {} : { headId: page.headId }),
    };
}

// The page is authoritative for the tail. Its oldest id locates the loaded
// prefix to keep; without a match the page replaces the window.
export function mergeHistoryUpdate<T extends Pick<HistoryUpdate, "entries" | "page">>(
    current: HistoryWindow,
    update: T,
): HistoryWindowMerge {
    const page = update.page;
    if (page === undefined || page.pageVersion !== HISTORY_PAGE_VERSION) {
        return {
            window: { entries: update.entries, hasEarlier: false },
            kind: "replace",
        };
    }
    if (current.entries.length === 0) {
        return { window: windowFromPage(update.entries, page), kind: "replace" };
    }
    const first = update.entries[0];
    const anchor = page.olderBefore ?? (first === undefined ? undefined : entryId(first));
    const index = anchor === undefined
        ? -1
        : current.entries.findIndex((entry) => entryId(entry) === anchor);
    if (index < 0) {
        return { window: windowFromPage(update.entries, page), kind: "replace" };
    }
    const kept = current.entries.slice(0, index);
    const keptPrefix = kept.length > 0;
    return {
        window: {
            entries: [...kept, ...update.entries],
            hasEarlier: keptPrefix ? current.hasEarlier : page.hasMore,
            ...(keptPrefix
                ? (current.olderBefore === undefined
                    ? {}
                    : { olderBefore: current.olderBefore })
                : (page.olderBefore === undefined
                    ? {}
                    : { olderBefore: page.olderBefore })),
            ...(page.headId === undefined ? {} : { headId: page.headId }),
        },
        kind: keptPrefix ? "append" : "replace",
    };
}

// Older pages are keyed by the id they were requested with, so a rewind or a
// compaction cannot invalidate them.
export function prependHistoryPage(
    current: HistoryWindow,
    page: HistoryPageSlice,
): HistoryWindowMerge {
    if (page.page.pageVersion !== HISTORY_PAGE_VERSION) {
        return { window: current, kind: "keep" };
    }
    if (current.olderBefore === undefined || page.before !== current.olderBefore) {
        return { window: current, kind: "keep" };
    }
    const loaded = new Set(
        current.entries.flatMap((entry) => {
            const id = entryId(entry);
            return id === undefined ? [] : [id];
        }),
    );
    const fresh = page.entries.filter((entry) => {
        const id = entryId(entry);
        return id === undefined || !loaded.has(id);
    });
    const hasEarlier = page.page.hasMore && page.page.olderBefore !== undefined;
    const next: HistoryWindow = {
        entries: fresh.length === 0 ? current.entries : [...fresh, ...current.entries],
        hasEarlier,
        ...(page.page.olderBefore === undefined
            ? {}
            : { olderBefore: page.page.olderBefore }),
        ...(current.headId === undefined ? {} : { headId: current.headId }),
    };
    if (fresh.length > 0) return { window: next, kind: "prepend" };
    // A page with no fresh rows is still progress when it moves the cursor.
    const moved = next.olderBefore !== current.olderBefore
        || hasEarlier !== current.hasEarlier;
    return moved ? { window: next, kind: "advance" } : { window: current, kind: "keep" };
}

// Paging progress is a change in the loaded rows or in the cursor.
export function historyWindowMoved(
    before: HistoryWindow | undefined,
    after: HistoryWindow | undefined,
): boolean {
    if (before === undefined || after === undefined) return before !== after;
    return before.entries.length !== after.entries.length
        || before.olderBefore !== after.olderBefore
        || before.hasEarlier !== after.hasEarlier;
}

// A reloaded window is complete for what it covers. A replacement keeps the
// texts already recalled from a branch the rewind abandoned.
export function mergeKnownUserTexts(
    known: readonly string[],
    merge: HistoryWindowMerge,
    incoming: readonly TranscriptEntry[],
): readonly string[] {
    if (merge.kind === "keep" || merge.kind === "advance") return known;
    if (merge.kind === "prepend" || merge.kind === "append") {
        return historyUserTexts(merge.window.entries);
    }
    const windowTexts = historyUserTexts(incoming);
    if (known.length === 0) return windowTexts;
    const next = [...known];
    for (const text of windowTexts) {
        if (!next.includes(text)) next.push(text);
    }
    return next;
}

export function mergeKnownUserPrompts(
    known: readonly HistoryUserPrompt[],
    merge: HistoryWindowMerge,
    incoming: readonly TranscriptEntry[],
): readonly HistoryUserPrompt[] {
    if (merge.kind === "keep" || merge.kind === "advance") return known;
    if (merge.kind === "prepend" || merge.kind === "append") {
        return historyUserPrompts(merge.window.entries);
    }
    const prompts = historyUserPrompts(incoming);
    if (known.length === 0) return prompts;
    const next = [...known];
    const keys = new Set(known.map((prompt) => JSON.stringify([prompt.text, prompt.attachmentIds ?? []])));
    for (const prompt of prompts) {
        const key = JSON.stringify([prompt.text, prompt.attachmentIds ?? []]);
        if (!keys.has(key)) {
            next.push(prompt);
            keys.add(key);
        }
    }
    return next;
}

// A fallback title is the first user text in the session, so only a window that
// reaches the start can supply one.
export function historyWindowFirstUserText(
    window: HistoryWindow,
): string | undefined {
    return window.hasEarlier
        ? undefined
        : historyUserTexts(window.entries)[0];
}
