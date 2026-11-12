import type { Block, NoticeBlock, Presentation, RetryState, ToolCall, ToolsBlock } from "./model.ts";
import { EMPTY_TURN_TEXT, failureText, failureTitle, substitutionText } from "./notices.ts";
import { toolTitle } from "./toolTitle.ts";
import type { DeliveryMessage, LiveMessage, SubstitutionMessage, ToolFinishedMessage, TurnFinishedMessage } from "./wire.ts";

// Keys come from the length of the list. Live blocks only grow until history replaces them,
// so a key taken this way is never handed out twice.
export function foldLive(live: readonly Block[], message: LiveMessage): readonly Block[] {
    switch (message.type) {
        case "user_prompt":
            return [...live, { kind: "user", key: keyFor(live), text: message.content }];
        case "assistant_thinking":
            return addThinking(live, message.text);
        case "assistant_delta":
            return addText(closeTail(settleThought(live)), message.text);
        case "tool_started":
            return startTool(settleThought(live), message.tool, message.args);
        case "tool_finished":
            return finishTool(live, message);
        case "tool_presentation":
            return presentTool(live, message.tool, message.presentation);
        case "model_substitution":
            return [...live, substitution(live, message)];
        case "task_notification":
            return [...live, delivery(live, message)];
        case "model_retry":
            return message.replacesPartial ? dropPartialText(live) : live;
        case "turn_finished":
            return endTurn(live, message);
        case "agent_failed":
            return [...settleTools(settleThought(live), "failed"), notice(live, "error", message.detail)];
        default:
            return live;
    }
}

export function keyFor(blocks: readonly Block[]): string {
    return `l${blocks.length}`;
}

function replaceTail(blocks: readonly Block[], block: Block): Block[] {
    return [...blocks.slice(0, -1), block];
}

function notice(blocks: readonly Block[], tone: "info" | "error", text: string): NoticeBlock {
    return { kind: "notice", key: keyFor(blocks), tone, text };
}

// The retry line stays up until the next attempt streams something or the turn ends.
export function retryAfter(retry: RetryState | undefined, message: LiveMessage): RetryState | undefined {
    switch (message.type) {
        case "model_retry":
            return message.retry;
        case "assistant_delta":
        case "assistant_thinking":
        case "tool_started":
        case "turn_finished":
        case "agent_failed":
            return undefined;
        default:
            return retry;
    }
}

function substitution(blocks: readonly Block[], message: SubstitutionMessage): Block {
    return {
        kind: "substitution",
        key: keyFor(blocks),
        text: substitutionText(message.substitution),
        scope: message.substitution.scope,
        source: message.source,
    };
}

function delivery(blocks: readonly Block[], message: DeliveryMessage): Block {
    const { delivery: sent } = message;
    return {
        kind: "delivery",
        key: keyFor(blocks),
        deliveryId: sent.deliveryId,
        sourceAgentId: sent.sourceAgentId,
        deliveryKind: sent.deliveryKind,
        text: sent.content,
        fromExtension: sent.fromExtension,
    };
}

// A retry that replaces the partial attempt sends its text again from the start.
function dropPartialText(blocks: readonly Block[]): readonly Block[] {
    return blocks.at(-1)?.kind === "text" ? blocks.slice(0, -1) : blocks;
}

function addThinking(live: readonly Block[], text: string): readonly Block[] {
    const tail = live.at(-1);
    if (tail?.kind === "thought" && tail.live) {
        return replaceTail(live, { ...tail, text: tail.text + text });
    }
    return [...live, { kind: "thought", key: keyFor(live), text, live: true }];
}

function addText(blocks: readonly Block[], text: string): readonly Block[] {
    const tail = blocks.at(-1);
    if (tail?.kind === "text") {
        return replaceTail(blocks, { ...tail, text: tail.text + text });
    }
    return [...blocks, { kind: "text", key: keyFor(blocks), text }];
}

// Joins the open group at the tail; a group closes when prose, a user prompt or the turn ends it.
function startTool(blocks: readonly Block[], tool: string, args: Readonly<Record<string, unknown>>): readonly Block[] {
    const call: ToolCall = { tool, title: toolTitle(tool, args), args, state: "running" };
    const tail = blocks.at(-1);
    if (tail?.kind === "tools" && tail.active) {
        return replaceTail(blocks, { ...tail, calls: [...tail.calls, call] });
    }
    return [...blocks, { kind: "tools", key: keyFor(blocks), calls: [call], active: true }];
}

// Finishes the last running call with this tool name, searching from the newest block back.
function finishTool(blocks: readonly Block[], message: ToolFinishedMessage): readonly Block[] {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.kind !== "tools") continue;
        const index = block.calls.findLastIndex((call) => call.tool === message.tool && call.state === "running");
        if (index === -1) continue;
        const calls = block.calls.map((call, position) => (position === index ? finished(call, message) : call));
        return blocks.map((other, position) => (position === i ? { ...block, calls } : other));
    }
    return blocks;
}

// Joins the newest finished call of this tool that has nothing attached yet.
function presentTool(blocks: readonly Block[], tool: string, presentation: Presentation): readonly Block[] {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block?.kind !== "tools") continue;
        const index = block.calls.findLastIndex((call) =>
            call.tool === tool && call.state !== "running" && call.presentation === undefined);
        if (index === -1) continue;
        const calls = block.calls.map((call, position) => (position === index ? { ...call, presentation } : call));
        return blocks.map((other, position) => (position === i ? { ...block, calls } : other));
    }
    return blocks;
}

function finished(call: ToolCall, message: ToolFinishedMessage): ToolCall {
    const state = message.isError ? "failed" : "done";
    return message.output === undefined ? { ...call, state } : { ...call, state, output: message.output };
}

function endTurn(live: readonly Block[], message: TurnFinishedMessage): readonly Block[] {
    const state = message.outcome === undefined ? "done" : "failed";
    const settled = settleTools(settleThought(live), state);
    const failure = message.modelFailure;
    if (failure !== undefined) {
        return [...settled, {
            ...notice(settled, "error", failureText(failure, message.error)),
            title: failureTitle(failure),
            ...(failure.resetsAt === undefined ? {} : { resetsAt: failure.resetsAt }),
        }];
    }
    if (message.outcome === "error") {
        return [...settled, notice(settled, "error", message.error ?? "The turn failed.")];
    }
    if (message.outcome === "aborted") {
        return [...settled, notice(settled, "info", "Stopped.")];
    }
    if (message.empty) return [...settled, notice(settled, "info", EMPTY_TURN_TEXT)];
    return settled;
}

// Turns a live reasoning block into a settled one, with its text trimmed.
export function settleThought(blocks: readonly Block[]): readonly Block[] {
    const tail = blocks.at(-1);
    if (tail?.kind !== "thought" || !tail.live) return blocks;
    return replaceTail(blocks, { ...tail, live: false, text: tail.text.trim() });
}

function closeTail(blocks: readonly Block[]): readonly Block[] {
    const tail = blocks.at(-1);
    if (tail?.kind !== "tools" || !tail.active) return blocks;
    return replaceTail(blocks, { ...tail, active: false });
}

// Closes every tool group and gives any call still running the given end state.
function settleTools(blocks: readonly Block[], state: "done" | "failed"): readonly Block[] {
    return blocks.map((block) => (block.kind === "tools" ? closeGroup(block, state) : block));
}

function closeGroup(block: ToolsBlock, state: "done" | "failed"): ToolsBlock {
    const calls = block.calls.map((call) => (call.state === "running" ? { ...call, state } : call));
    return { ...block, active: false, calls };
}
