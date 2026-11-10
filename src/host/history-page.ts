import type {
    HistoryPageInfo,
    TranscriptEntry,
} from "../engine/protocol.ts";
import type { SessionStore } from "../store/session-store.ts";
import { projectIndexedMessage } from "../session-transcript.ts";

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
    const turnUsers: number[] = [];
    const turnEnds = new Map<number, number>();
    const oversizedTurns = new Map<number, boolean>();
    const entrySizes: number[] = [];
    let currentUser = -1;
    for (let index = 0; index < entries.length; index += 1) {
        if (entries[index]!.kind === "user") {
            if (currentUser >= 0) turnEnds.set(currentUser, index);
            currentUser = index;
        }
        turnUsers.push(currentUser);
    }
    if (currentUser >= 0) turnEnds.set(currentUser, entries.length);

    const entrySize = (index: number): number => {
        const cached = entrySizes[index];
        if (cached !== undefined) return cached;
        const size = entryByteLength(entries[index]!);
        entrySizes[index] = size;
        return size;
    };
    const groupStart = (index: number): number => {
        const messageStart = messageGroupStart(entries, index);
        const userIndex = turnUsers[index]!;
        if (userIndex < 0) return messageStart;
        const turnStart = messageGroupStart(entries, userIndex);
        const turnEnd = turnEnds.get(userIndex)!;
        let oversized = oversizedTurns.get(userIndex);
        if (oversized === undefined) {
            oversized = turnEnd - turnStart > HISTORY_PAGE_MAX_ENTRIES;
            let turnBytes = 1;
            for (let cursor = turnStart; !oversized && cursor < turnEnd; cursor += 1) {
                turnBytes += entrySize(cursor) + 1;
                oversized = turnBytes > HISTORY_PAGE_MAX_BYTES;
            }
            oversizedTurns.set(userIndex, oversized);
        }
        return oversized ? messageStart : turnStart;
    };

    let end = entries.length;
    if (before !== undefined) {
        const index = entries.findIndex((entry) => entry.id === before);
        if (index < 0) {
            return { kind: "cursor_not_found" };
        }
        end = messageGroupStart(entries, index);
    }
    let start = end;
    let count = 0;
    let bytes = 0;
    while (start > 0) {
        const groupFrom = groupStart(start - 1);
        const sizes: number[] = [];
        let groupBytes = 0;
        for (let index = groupFrom; index < start; index += 1) {
            const size = entrySize(index);
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
                || bytes + groupBytes + count + sizes.length + 1 > HISTORY_PAGE_MAX_BYTES)
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

export interface StoreHistoryPageOptions {
    /** Lets a reader that must reach every entry take one above the entry cap. */
    readonly allowOversized?: boolean;
}

/** Builds a page by walking the cursor message's own ancestor chain in the store; no cursor reads the latest page. */
export async function historyPageFromStore(
    store: SessionStore,
    before?: string,
    options: StoreHistoryPageOptions = {},
): Promise<HistoryPageResult> {
    if (before === undefined) {
        return store.exclusively(() => indexedPage(store, store.activeHeadId(), undefined, options));
    }
    const messageId = messageIdOfEntryId(before);
    if (messageId === undefined) {
        return { kind: "cursor_not_found" };
    }
    return store.exclusively(() => indexedPage(store, messageId, before, options));
}

interface IndexedPageGroup {
    readonly record: number;
    readonly entries: readonly TranscriptEntry[];
}

async function indexedPage(
    store: SessionStore,
    messageId: string | null,
    before: string | undefined,
    options: StoreHistoryPageOptions,
): Promise<HistoryPageResult> {
    const pageOptions = options.allowOversized === true ? { allowOversizedTail: true } : {};
    if (messageId === null) {
        return historyPageFromEntries(await decorateIndexedPage(store, null, [], Infinity, true), undefined, pageOptions);
    }
    if (await store.readMessageEntry(messageId) === undefined) return { kind: "cursor_not_found" };
    const headId = store.activeHeadId() ?? undefined;
    const groups: IndexedPageGroup[] = [];
    let count = 0;
    let bytes = 1;
    let oldest = Infinity;
    let first = true;
    let complete = false;
    let scanned = 0;
    for await (const message of store.walkMessageAncestors(messageId)) {
        scanned += 1;
        const record = await store.messageRecordNumber(message.id);
        if (record === undefined) throw new Error(`Session message ${message.id} is unavailable`);
        oldest = record;
        complete = message.parentId === null;
        const entries = await projectIndexedMessage(store, message);
        if (first) {
            first = false;
            if (before !== undefined && !entries.some((entry) => entry.id === before)) return { kind: "cursor_not_found" };
        }
        if (entries.length > 0) {
            groups.push({ record, entries });
            count += entries.length;
            for (const entry of entries) bytes += entryByteLength(entry) + 1;
        }
        if (!complete && count <= HISTORY_PAGE_MAX_ENTRIES && bytes <= HISTORY_PAGE_MAX_BYTES && scanned % 32 !== 0) continue;
        const candidate = await decorateIndexedPage(store, messageId, groups, oldest, complete);
        const result = historyPageFromEntries(candidate, before, { ...(headId === undefined ? {} : { headId }), ...pageOptions });
        if (complete || result.kind !== "page") return result;
        if (!result.page.hasMore || result.entries.length === 0) continue;
        const start = candidate.indexOf(result.entries[0]!);
        const firstUser = candidate.findIndex((entry) => entry.kind === "user");
        if (firstUser >= 0 && firstUser <= start) return result;
        const end = firstUser < 0 ? candidate.length : firstUser;
        let prefixBytes = 1;
        for (let index = 0; index < end; index += 1) prefixBytes += entryByteLength(candidate[index]!) + 1;
        if (end > HISTORY_PAGE_MAX_ENTRIES || prefixBytes > HISTORY_PAGE_MAX_BYTES) return result;
    }
    return { kind: "cursor_not_found" };
}

async function decorateIndexedPage(
    store: SessionStore,
    headId: string | null,
    groups: readonly IndexedPageGroup[],
    oldest: number,
    complete: boolean,
): Promise<TranscriptEntry[]> {
    const byRecord = new Map<number, { entries: readonly TranscriptEntry[]; harness: { ordinal: number; entry: TranscriptEntry }[] }>();
    for (const group of groups) byRecord.set(group.record, { entries: group.entries, harness: [] });
    for await (const { ordinal, entry } of store.walkHarnessMessages()) {
        const record = await store.harnessPosition(headId, entry);
        if (record === undefined || (record === -1 ? !complete : record < oldest)) continue;
        let group = byRecord.get(record);
        if (group === undefined) {
            group = { entries: [], harness: [] };
            byRecord.set(record, group);
        }
        group.harness.push({ ordinal, entry: { kind: "harness", id: `harness:${ordinal}`, text: entry.text, tone: entry.tone } });
    }
    const result: TranscriptEntry[] = [];
    for (const [, group] of [...byRecord].sort(([left], [right]) => left - right)) {
        for (const entry of group.entries) result.push(entry);
        group.harness.sort((left, right) => left.ordinal - right.ordinal);
        for (const harness of group.harness) result.push(harness.entry);
    }
    return result;
}

function messageGroupStart(
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
