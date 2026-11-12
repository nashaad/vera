import type { AgentRunStatus, Block, NoticeTone, SessionWatch, ToolCall, ToolState } from "./model.ts";
import { MAX_HISTORY_BLOCKS } from "./model.ts";
import { foldLive } from "./live.ts";
import { toolTitle } from "./toolTitle.ts";
import type { LiveMessage, PageInfo, SessionMessage, ToolResultEntry, WireEntry } from "./wire.ts";

// Stored history has no call ids, so a result pairs with the earliest unpaired call of the same tool.
export function entriesToBlocks(entries: readonly WireEntry[], prefix = "h"): Block[] {
    const blocks: Block[] = [];
    entries.forEach((entry, index) => addEntry(blocks, entry, entryKey(entry, index, prefix)));
    return blocks.map(finishHistoryCall);
}

// Entries without an id are keyed by position, with a prefix per page so pages never collide.
function entryKey(entry: WireEntry, index: number, prefix: string): string {
    return "id" in entry && entry.id !== undefined ? entry.id : `${prefix}${index}`;
}

function timed(entry: WireEntry): { at?: number } {
    return "recordedAt" in entry && entry.recordedAt !== undefined ? { at: entry.recordedAt } : {};
}

function addEntry(blocks: Block[], entry: WireEntry, key: string): void {
    switch (entry.kind) {
        case "user":
            blocks.push({ kind: "user", key, text: entry.text, ...timed(entry) });
            return;
        case "assistant":
            if (entry.text.trim().length > 0) blocks.push({ kind: "text", key, text: entry.text, ...timed(entry) });
            return;
        case "reasoning":
            if (entry.text.trim().length > 0) {
                blocks.push({ kind: "thought", key, text: entry.text, live: false, ...timed(entry) });
            }
            return;
        case "tool":
            joinOrStartGroup(blocks, key, toolCall(entry.tool, entry.args), timed(entry));
            return;
        case "tool_result":
            pairResult(blocks, entry);
            return;
        case "error":
            blocks.push({ kind: "notice", key, tone: "error", text: entry.detail ?? entry.outcome ?? "The turn failed.", ...timed(entry) });
            return;
        case "harness":
            blocks.push({ kind: "notice", key, tone: harnessTone(entry.tone), text: entry.text, ...timed(entry) });
            return;
        case "other":
            return;
    }
}

// Calls start as running so a result can find them; whatever no result claims is done.
function toolCall(tool: string, args: Readonly<Record<string, unknown>>): ToolCall {
    return { tool, title: toolTitle(tool, args), args, state: "running" };
}

function joinOrStartGroup(
    blocks: Block[],
    key: string,
    call: ToolCall,
    timing: { at?: number },
): void {
    const tail = blocks.at(-1);
    if (tail?.kind === "tools") {
        blocks[blocks.length - 1] = { ...tail, calls: [...tail.calls, call] };
        return;
    }
    blocks.push({ kind: "tools", key, calls: [call], active: false, ...timing });
}

function pairResult(blocks: Block[], entry: ToolResultEntry): void {
    const tail = blocks.at(-1);
    if (tail?.kind !== "tools") return;
    const index = tail.calls.findIndex((call) => call.tool === entry.tool && call.state === "running");
    if (index === -1) return;
    const state: ToolState = entry.isError ? "failed" : "done";
    const calls = tail.calls.map((call, position): ToolCall =>
        position === index ? { ...call, state, output: entry.output } : call);
    blocks[blocks.length - 1] = { ...tail, calls };
}

function finishHistoryCall(block: Block): Block {
    if (block.kind !== "tools") return block;
    const calls = block.calls.map((call) => (call.state === "running" ? { ...call, state: "done" as const } : call));
    return { ...block, calls };
}

function harnessTone(tone: string): NoticeTone {
    return tone === "error" ? "error" : "info";
}

export function initialWatch(agentId: string): SessionWatch {
    return {
        agentId,
        phase: "attaching",
        history: [],
        live: [],
        status: "idle",
        hasOlder: false,
        loadingOlder: false,
    };
}

export function reduceWatch(state: SessionWatch, message: SessionMessage): SessionWatch {
    switch (message.type) {
        case "attached":
            return { ...state, phase: "attached" };
        case "attach_failed":
            return { ...state, phase: "failed", error: attachFailure(message.reason) };
        case "history":
            return {
                ...state,
                history: entriesToBlocks(message.entries).slice(-MAX_HISTORY_BLOCKS),
                live: [],
                status: message.status ?? "idle",
                loadingOlder: false,
                ...cursorOf(message.page),
            };
        case "history_page":
            return prependPage(state, entriesToBlocks(message.entries, `p${state.olderBefore ?? ""}:`), message.page);
        case "history_page_failed":
            return { ...state, loadingOlder: false };
        case "session_title":
            return { ...state, title: message.title };
        default:
            return { ...state, live: foldLive(state.live, message), status: statusAfter(state.status, message) };
    }
}

// A page that pushes history past the cap keeps only its newest blocks; at the cap no older page is asked for.
function prependPage(state: SessionWatch, pageBlocks: Block[], page: PageInfo): SessionWatch {
    const combined = [...pageBlocks, ...state.history];
    const overflow = combined.length - MAX_HISTORY_BLOCKS;
    const cursor = cursorOf(page);
    return {
        ...state,
        history: overflow > 0 ? combined.slice(overflow) : combined,
        loadingOlder: false,
        ...cursor,
        hasOlder: overflow > 0 || cursor.hasOlder,
    };
}

function cursorOf(page: PageInfo | undefined): { hasOlder: boolean; olderBefore?: string } {
    const olderBefore = page?.olderBefore;
    return {
        hasOlder: page?.hasMore === true && olderBefore !== undefined,
        olderBefore,
    };
}

function statusAfter(status: AgentRunStatus, message: LiveMessage): AgentRunStatus {
    switch (message.type) {
        case "status":
            return message.state;
        case "user_prompt":
            return "working";
        case "turn_finished":
        case "agent_failed":
            return "idle";
        default:
            return status;
    }
}

function attachFailure(reason: string): string {
    switch (reason) {
        case "not_found":
            return "This session no longer exists.";
        case "unavailable":
            return "This session is unavailable right now.";
        case "history_paging_required":
            return "This session's history could not be sent in pages.";
        default:
            return "This session could not be opened.";
    }
}

export function canLoadOlder(state: SessionWatch): boolean {
    return state.hasOlder && !state.loadingOlder && state.olderBefore !== undefined
        && state.history.length < MAX_HISTORY_BLOCKS;
}

export function beginOlder(state: SessionWatch): SessionWatch {
    if (!canLoadOlder(state)) return state;
    return { ...state, loadingOlder: true };
}

export function watchClosed(state: SessionWatch, reason: string): SessionWatch {
    if (state.phase === "failed") return state;
    return { ...state, phase: "closed", error: reason };
}
