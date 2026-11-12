import type { Block, ToolCall, ToolsBlock } from "./model.ts";
import { toolTitle } from "./toolTitle.ts";
import type { LiveMessage, ToolFinishedMessage, TurnFinishedMessage } from "./wire.ts";

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
        case "turn_finished":
            return endTurn(live, message);
        case "agent_failed":
            return [...settleTools(settleThought(live), "failed"), notice(live, "error", message.detail)];
        default:
            return live;
    }
}

function keyFor(blocks: readonly Block[]): string {
    return `l${blocks.length}`;
}

function replaceTail(blocks: readonly Block[], block: Block): Block[] {
    return [...blocks.slice(0, -1), block];
}

function notice(blocks: readonly Block[], tone: "info" | "error", text: string): Block {
    return { kind: "notice", key: keyFor(blocks), tone, text };
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

function finished(call: ToolCall, message: ToolFinishedMessage): ToolCall {
    const state = message.isError ? "failed" : "done";
    return message.output === undefined ? { ...call, state } : { ...call, state, output: message.output };
}

function endTurn(live: readonly Block[], message: TurnFinishedMessage): readonly Block[] {
    const state = message.outcome === undefined ? "done" : "failed";
    const settled = settleTools(settleThought(live), state);
    if (message.outcome === "error") {
        return [...settled, notice(settled, "error", message.error ?? "The turn failed.")];
    }
    if (message.outcome === "aborted") {
        return [...settled, notice(settled, "info", "Stopped.")];
    }
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
