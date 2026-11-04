import type {
    HistoryPageInfo,
    TranscriptEntry,
} from "../engine/protocol.ts";
import { projectTranscript } from "../engine/protocol.ts";
import type { SessionStore } from "../store/session-store.ts";

export const HISTORY_PAGE_VERSION = 1;
export const HISTORY_PAGE_MAX_ENTRIES = 240;
export const HISTORY_PAGE_MAX_BYTES = 1_024 * 1_024;
export const HISTORY_PAGE_MAX_ENTRY_BYTES = 8 * 1_024 * 1_024;

export type HistoryPageResult =
    | {
        readonly kind: "page";
        readonly entries: readonly TranscriptEntry[];
        readonly page: HistoryPageInfo;
    }
    | { readonly kind: "cursor_not_found" }
    | { readonly kind: "page_too_large" };

export interface HistoryPageOptions {
    /** The active leaf, when the caller knows it. Derived from the entries otherwise. */
    readonly headId?: string;
    /** A tail page cannot fail; send the newest entry even above the entry cap. */
    readonly allowOversizedTail?: boolean;
}

/** Builds a page from an already-projected transcript, newest page first. */
export function historyPageFromEntries(
    entries: readonly TranscriptEntry[],
    before?: string,
    options: HistoryPageOptions = {},
): HistoryPageResult {
    let end = entries.length;
    if (before !== undefined) {
        const index = entries.findIndex((entry) => entry.id === before);
        if (index < 0) {
            return { kind: "cursor_not_found" };
        }
        end = groupStart(entries, index);
    }
    let start = end;
    let count = 0;
    let bytes = 0;
    while (start > 0) {
        const groupFrom = groupStart(entries, start - 1);
        const sizes: number[] = [];
        let groupBytes = 0;
        for (let index = groupFrom; index < start; index += 1) {
            const size = entryByteLength(entries[index]!);
            sizes.push(size);
            groupBytes += size;
        }
        const oversized = sizes.some(
            (size) => size > HISTORY_PAGE_MAX_ENTRY_BYTES,
        );
        if (oversized && !(count === 0 && options.allowOversizedTail === true)) {
            if (count === 0) {
                return { kind: "page_too_large" };
            }
            break;
        }
        if (
            count > 0
            && (count + sizes.length > HISTORY_PAGE_MAX_ENTRIES
                || bytes + groupBytes > HISTORY_PAGE_MAX_BYTES)
        ) {
            break;
        }
        start = groupFrom;
        count += sizes.length;
        bytes += groupBytes;
        if (
            bytes >= HISTORY_PAGE_MAX_BYTES
            || count >= HISTORY_PAGE_MAX_ENTRIES
        ) {
            break;
        }
    }
    const pageEntries = entries.slice(start, end);
    const firstId = pageEntries.find(
        (entry) => entry.id !== undefined
            && messageIdOfEntryId(entry.id) !== undefined,
    )?.id;
    const hasMore = start > 0 && firstId !== undefined;
    let tailId: string | undefined;
    for (let index = pageEntries.length - 1; index >= 0; index -= 1) {
        const id = pageEntries[index]!.id;
        if (id !== undefined) {
            tailId = id;
            break;
        }
    }
    const headId = options.headId ?? headEntryId(entries);
    return {
        kind: "page",
        entries: pageEntries,
        page: {
            pageVersion: HISTORY_PAGE_VERSION,
            hasMore,
            ...(hasMore && firstId !== undefined
                ? { olderBefore: firstId }
                : {}),
            ...(headId === undefined ? {} : { headId }),
            ...(tailId === undefined ? {} : { tailId }),
        },
    };
}

/** Builds a page by walking the cursor message's own ancestor chain in the store. */
export function historyPageFromStore(
    store: SessionStore,
    before: string,
): HistoryPageResult {
    const messageId = messageIdOfEntryId(before);
    if (messageId === undefined) {
        return { kind: "cursor_not_found" };
    }
    const source = store.pageSourceTo(messageId);
    if (source === undefined) {
        return { kind: "cursor_not_found" };
    }
    const entries = projectTranscript(
        source.messages,
        source.attachmentName,
        source.messageStamps,
        source.harnessMessages,
        source.deliveredMessages,
    );
    return historyPageFromEntries(entries, before, {
        ...(source.headId === undefined ? {} : { headId: source.headId }),
    });
}

/**
 * The first entry of the message group containing `index`. A harness row
 * belongs to the message before it, so its group starts at that message.
 */
function groupStart(
    entries: readonly TranscriptEntry[],
    index: number,
): number {
    let cursor = index;
    while (
        cursor > 0
        && messageIdOfEntryId(entries[cursor]!.id) === undefined
    ) {
        cursor -= 1;
    }
    const messageId = messageIdOfEntryId(entries[cursor]!.id);
    if (messageId === undefined) {
        return 0;
    }
    let start = cursor;
    while (start > 0) {
        const previousId = entries[start - 1]!.id;
        if (
            previousId === undefined
            || messageIdOfEntryId(previousId) !== messageId
        ) {
            break;
        }
        start -= 1;
    }
    return start;
}

function headEntryId(
    entries: readonly TranscriptEntry[],
): string | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const messageId = messageIdOfEntryId(entries[index]!.id);
        if (messageId !== undefined) {
            return messageId;
        }
    }
    return undefined;
}

function messageIdOfEntryId(entryId: string | undefined): string | undefined {
    if (entryId === undefined) {
        return undefined;
    }
    const hash = entryId.lastIndexOf("#");
    if (hash <= 0 || hash === entryId.length - 1) {
        return undefined;
    }
    return entryId.slice(0, hash);
}

function entryByteLength(entry: TranscriptEntry): number {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
}
