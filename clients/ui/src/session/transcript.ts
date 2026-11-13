import { mergeModelSettingsReply } from "../models/settings.ts";
import type { AgentRunStatus, Block, NoticeTone, Presentation, SessionWatch, ToolCall, ToolState } from "./model.ts";
import { MAX_HISTORY_BLOCKS, MAX_IMAGE_REPLIES } from "./model.ts";
import { foldLive, keyFor, retryAfter } from "./live.ts";
import { EMPTY_TURN_TEXT, compactionNotice, failureText, failureTitle, substitutionText } from "./notices.ts";
import { addRequest, closeRequest } from "./requests.ts";
import { toolTitle } from "./toolTitle.ts";
import type { LiveMessage, PageInfo, SessionMessage, ToolResultEntry, WireEntry } from "./wire.ts";

// Where the last tool result landed, so the presentation stored after it can join the same call.
interface Paired {
    block: number;
    call: number;
}

// Stored history has no call ids, so a result pairs with the earliest unpaired call of the same tool.
export function entriesToBlocks(entries: readonly WireEntry[], prefix = "h"): Block[] {
    const blocks: Block[] = [];
    const paired: { last?: Paired } = {};
    entries.forEach((entry, index) => addEntry(blocks, entry, entryKey(entry, index, prefix), paired));
    return blocks.map(finishHistoryCall);
}

// Entries without an id are keyed by position, with a prefix per page so pages never collide.
function entryKey(entry: WireEntry, index: number, prefix: string): string {
    return "id" in entry && entry.id !== undefined ? entry.id : `${prefix}${index}`;
}

function timed(entry: WireEntry): { at?: number } {
    return "recordedAt" in entry && entry.recordedAt !== undefined ? { at: entry.recordedAt } : {};
}

function addEntry(blocks: Block[], entry: WireEntry, key: string, paired: { last?: Paired }): void {
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
            paired.last = pairResult(blocks, entry);
            return;
        case "presentation":
            if (paired.last !== undefined) attachPresentation(blocks, paired.last, entry.presentation);
            paired.last = undefined;
            return;
        case "error": {
            const failure = entry.modelFailure;
            const text = failure === undefined
                ? entry.detail ?? (entry.outcome === "aborted" ? "Stopped." : "The turn failed.")
                : failureText(failure, entry.detail);
            const tone: NoticeTone = entry.outcome === "aborted" && failure === undefined ? "info" : "error";
            blocks.push({
                kind: "notice",
                key,
                tone,
                text,
                ...(failure === undefined ? {} : { title: failureTitle(failure) }),
                ...(failure?.resetsAt === undefined ? {} : { resetsAt: failure.resetsAt }),
                ...timed(entry),
            });
            return;
        }
        case "empty":
            blocks.push({ kind: "notice", key, tone: "info", text: EMPTY_TURN_TEXT, ...timed(entry) });
            return;
        case "model_substitution":
            blocks.push({
                kind: "substitution",
                key,
                text: substitutionText(entry.substitution),
                scope: entry.substitution.scope,
                source: "turn",
                ...timed(entry),
            });
            return;
        case "delivery": {
            const { delivery } = entry;
            blocks.push({
                kind: "delivery",
                key,
                deliveryId: delivery.deliveryId,
                sourceAgentId: delivery.sourceAgentId,
                deliveryKind: delivery.deliveryKind,
                text: delivery.content,
                fromExtension: delivery.fromExtension,
                ...timed(entry),
            });
            return;
        }
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

function pairResult(blocks: Block[], entry: ToolResultEntry): Paired | undefined {
    const tail = blocks.at(-1);
    if (tail?.kind !== "tools") return undefined;
    const index = tail.calls.findIndex((call) => call.tool === entry.tool && call.state === "running");
    if (index === -1) return undefined;
    const state: ToolState = entry.isError ? "failed" : "done";
    const calls = tail.calls.map((call, position): ToolCall =>
        position === index ? { ...call, state, output: entry.output } : call);
    blocks[blocks.length - 1] = { ...tail, calls };
    return { block: blocks.length - 1, call: index };
}

function attachPresentation(blocks: Block[], at: Paired, presentation: Presentation): void {
    const block = blocks[at.block];
    if (block?.kind !== "tools") return;
    const calls = block.calls.map((call, position): ToolCall => (position === at.call ? { ...call, presentation } : call));
    blocks[at.block] = { ...block, calls };
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
        loaded: false,
        history: [],
        live: [],
        status: "idle",
        hasOlder: false,
        loadingOlder: false,
        queue: [],
        images: [],
        requests: [],
    };
}

export function reduceWatch(state: SessionWatch, message: SessionMessage): SessionWatch {
    switch (message.type) {
        case "attach_failed":
            return { ...state, phase: "failed", error: attachFailure(message.reason) };
        case "attached":
            return { ...state, phase: "attached", ...(message.background === undefined ? {} : { background: message.background }) };
        case "history":
            return {
                ...state,
                loaded: true,
                history: entriesToBlocks(message.entries).slice(-MAX_HISTORY_BLOCKS),
                live: [],
                status: message.status ?? "idle",
                loadingOlder: false,
                queue: message.queue ?? [],
                // Open requests outlive a checkpoint; an idle session has none.
                requests: (message.status ?? "idle") === "idle" ? [] : state.requests,
                retry: undefined,
                ...cursorOf(message.page),
                ...(message.context === undefined ? {} : { context: message.context }),
                ...(message.usage === undefined ? {} : { usage: message.usage }),
            };
        case "history_page":
            return prependPage(state, entriesToBlocks(message.entries, `p${state.olderBefore ?? ""}:`), message.page);
        case "history_page_failed":
            return { ...state, loadingOlder: false };
        case "session_title":
            return { ...state, title: message.title };
        case "prompt_queue":
            return { ...state, queue: message.queue };
        case "prompt_withdrawn":
            return { ...state, withdrawn: { requestId: message.requestId, content: message.content } };
        case "image_reply":
            return { ...state, images: [...state.images, message.reply].slice(-MAX_IMAGE_REPLIES) };
        case "prompt_refused": {
            const { type: _type, ...refused } = message;
            return { ...state, refused };
        }
        case "ui_request":
            return { ...state, requests: addRequest(state.requests, message.request) };
        case "ui_request_closed":
            return { ...state, requests: closeRequest(state.requests, message.requestId) };
        case "permissions":
            return { ...state, approval: message.approval };
        case "permissions_rejected":
            return { ...state, approvalRefused: message.requestId };
        case "model_settings":
            return { ...state, models: mergeModelSettingsReply(state.models, message.reply) };
        case "model_settings_rejected":
            return { ...state, modelRefused: message.refusal };
        case "context":
            return { ...state, context: message.context };
        case "compaction":
            return withCompaction(state, message.compaction);
        case "timeline_reply":
            return { ...state, timeline: message.reply };
        case "background_agents":
            return { ...state, background: message.background };
        default: {
            const ended = message.type === "turn_finished" || message.type === "agent_failed";
            const usage = message.type === "turn_finished" ? message.usage : undefined;
            return {
                ...state,
                live: foldLive(state.live, message),
                status: statusAfter(state.status, message),
                // A finished turn cannot still be waiting on an answer.
                requests: ended ? [] : state.requests,
                retry: retryAfter(state.retry, message),
                ...(usage === undefined ? {} : { usage }),
            };
        }
    }
}

// A finished compaction leaves a notice in the transcript; the next checkpoint replaces it.
function withCompaction(state: SessionWatch, compaction: SessionWatch["compaction"] & object): SessionWatch {
    const notice = compactionNotice(compaction);
    if (notice === undefined) return { ...state, compaction };
    const block: Block = { kind: "notice", key: keyFor(state.live), tone: notice.tone, text: notice.text };
    return { ...state, compaction, live: [...state.live, block] };
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

export function watchOpening(watch: SessionWatch): boolean {
    return !watch.loaded && (watch.phase === "attaching" || watch.phase === "attached");
}

export function watchClosed(state: SessionWatch, reason: string): SessionWatch {
    if (state.phase === "failed") return state;
    return { ...state, phase: "closed", error: reason };
}
