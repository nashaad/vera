import type {
    TuiTextTranscriptEntry,
    TuiTranscriptEntry,
} from "./state.ts";
import { withTranscriptEntryAlias } from "./transcript-entry-id.ts";

// Folds consecutive `process` reads of one background process into a single
// Waiting/Waited row group.
export const WAIT_LIVE_HEADER = "Waiting";
export const WAIT_SETTLED_HEADER = "Waited";

const WAIT_TOOL = "process";
const CALL_PREFIX = "  └ ";
const CONNECTED_PREFIX = "  │ ";

// Rows a streak may sit between without being broken.
function isSkippable(entry: TuiTranscriptEntry): boolean {
    return entry.kind === "review"
        || entry.kind === "thought"
        || entry.kind === "thinking";
}

// Rows that belong to a tool group's own run.
function isGroupMember(entry: TuiTranscriptEntry | undefined): boolean {
    return entry !== undefined && (entry.kind === "tool" || isSkippable(entry));
}

export function processReadId(
    tool: string,
    args: Readonly<Record<string, unknown>>,
): string | undefined {
    if (tool !== WAIT_TOOL || args.action !== "read") return undefined;
    const processId = args.process_id;
    return typeof processId === "string" && processId.length > 0
        ? processId
        : undefined;
}

// The bash row that started the process; its text is already the command.
export function waitCommandText(
    entries: readonly TuiTranscriptEntry[],
    processId: string,
): string {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (
            entry !== undefined
            && entry.kind === "tool"
            && entry.result !== true
            && entry.startedProcessId === processId
        ) {
            return entry.text;
        }
    }
    return processId;
}

export function activeWaitProcessId(
    entries: readonly TuiTranscriptEntry[],
): string | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (
            entry !== undefined
            && entry.kind === "tool"
            && entry.active === true
            && entry.waitProcessId !== undefined
        ) {
            return entry.waitProcessId;
        }
    }
    return undefined;
}

// Opens, or reopens, the wait group for one poll. Reopening a settled group
// keeps its newest result on screen until the next poll lands.
export function withWaitPoll(
    entries: readonly TuiTranscriptEntry[],
    processId: string,
    command: string,
    live: boolean,
    entryId?: string,
): TuiTranscriptEntry[] {
    const previousIndex = entries.findLastIndex((entry) => !isSkippable(entry));
    const previous = entries[previousIndex];
    if (
        previous !== undefined
        && previous.kind === "tool"
        && previous.waitProcessId === processId
    ) {
        if (!live || previous.result !== true) {
            const callIndex = waitCallIndex(entries, processId);
            return entries.map((entry, index) => index === callIndex && entry.kind === "tool"
                ? withTranscriptEntryAlias(entry, entryId)
                : entry);
        }
        const callIndex = waitCallIndex(entries, processId);
        const headerIndex = callIndex === -1
            ? -1
            : waitHeaderIndex(entries, callIndex);
        if (callIndex === -1 || headerIndex === -1) return [...entries];
        return entries.map((entry, index) => {
            if (index === headerIndex && entry.kind === "tool_header") {
                return {
                    ...entry,
                    header: WAIT_LIVE_HEADER,
                    text: WAIT_LIVE_HEADER,
                    active: true,
                };
            }
            if (index === callIndex && entry.kind === "tool") {
                return {
                    ...entry,
                    header: WAIT_LIVE_HEADER,
                    tool: WAIT_TOOL,
                    active: true,
                };
            }
            return entry;
        });
    }

    const header = live ? WAIT_LIVE_HEADER : WAIT_SETTLED_HEADER;
    const headerEntry: TuiTextTranscriptEntry = {
        kind: "tool_header",
        header,
        ...(live ? { active: true } : {}),
        text: header,
        waitProcessId: processId,
    };
    const callEntry: TuiTextTranscriptEntry = {
        kind: "tool",
        header,
        ...(live ? { tool: WAIT_TOOL, active: true } : {}),
        prefix: CALL_PREFIX,
        text: command,
        waitProcessId: processId,
        ...(entryId === undefined ? {} : { entryId }),
    };
    return [...entries, headerEntry, callEntry];
}

// Settles the newest poll of one wait group, replacing any earlier result.
// Returns undefined when no wait group matches, so the caller can fall back.
export function withWaitResult(
    entries: readonly TuiTranscriptEntry[],
    processId: string | undefined,
    resultText: string | undefined,
    entryId?: string,
): TuiTranscriptEntry[] | undefined {
    const callIndex = waitCallIndex(entries, processId);
    if (callIndex === -1) return undefined;
    const call = entries[callIndex];
    if (call?.kind !== "tool") return undefined;
    const waitProcessId = call.waitProcessId ?? processId;
    if (waitProcessId === undefined) return undefined;
    const headerIndex = waitHeaderIndex(entries, callIndex);
    if (headerIndex === -1) return undefined;
    const end = waitGroupEnd(entries, headerIndex);

    let resultIndex = -1;
    for (let index = callIndex + 1; index < end; index += 1) {
        const entry = entries[index];
        if (
            entry !== undefined
            && entry.kind === "tool"
            && entry.result === true
            && entry.waitProcessId === waitProcessId
        ) {
            resultIndex = index;
            break;
        }
    }

    const next = entries.map((entry, index) => {
        if (index === headerIndex && entry.kind === "tool_header") {
            const { active: _active, ...settled } = entry;
            return {
                ...settled,
                header: WAIT_SETTLED_HEADER,
                text: WAIT_SETTLED_HEADER,
            };
        }
        if (index === callIndex && entry.kind === "tool") {
            const {
                active: _active,
                tool: _tool,
                activity: _activity,
                ...settled
            } = entry;
            return {
                ...settled,
                header: WAIT_SETTLED_HEADER,
                prefix: CONNECTED_PREFIX,
            };
        }
        if (index === resultIndex && entry.kind === "tool") {
            return withTranscriptEntryAlias({
                ...entry,
                header: WAIT_SETTLED_HEADER,
                text: resultText ?? entry.text,
            }, entryId);
        }
        return entry;
    });
    if (resultText !== undefined && resultIndex === -1) {
        next.splice(callIndex + 1, 0, {
            kind: "tool",
            header: WAIT_SETTLED_HEADER,
            result: true,
            prefix: CALL_PREFIX,
            text: resultText,
            waitProcessId,
            ...(entryId === undefined ? {} : { entryId }),
        });
    }
    return next;
}

// A turn that ends mid-poll leaves the newest result in place, settled.
export function settleActiveWait(
    entries: readonly TuiTranscriptEntry[],
    resultText?: string,
): TuiTranscriptEntry[] | undefined {
    const processId = activeWaitProcessId(entries);
    return processId === undefined
        ? undefined
        : withWaitResult(entries, processId, resultText);
}

function waitCallIndex(
    entries: readonly TuiTranscriptEntry[],
    processId: string | undefined,
): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (
            entry !== undefined
            && entry.kind === "tool"
            && entry.result !== true
            && entry.waitProcessId !== undefined
            && (processId === undefined || entry.waitProcessId === processId)
        ) {
            return index;
        }
    }
    return -1;
}

function waitHeaderIndex(
    entries: readonly TuiTranscriptEntry[],
    callIndex: number,
): number {
    for (let index = callIndex - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) return -1;
        if (entry.kind === "tool_header") {
            return entry.waitProcessId === undefined ? -1 : index;
        }
        if (!isGroupMember(entry)) return -1;
    }
    return -1;
}

function waitGroupEnd(
    entries: readonly TuiTranscriptEntry[],
    headerIndex: number,
): number {
    let end = headerIndex + 1;
    while (isGroupMember(entries[end])) end += 1;
    return end;
}
