import type { AgentFrame } from "../../../src/rpc/frames.ts";

export type TranscriptEntryKind = "user" | "assistant" | "tool" | "notice";

export interface TranscriptEntry {
    readonly kind: TranscriptEntryKind;
    readonly text: string;
}

export interface PageState {
    readonly entries: readonly TranscriptEntry[];
    readonly working: boolean;
    readonly queuedPrompts: readonly string[];
}

export function createPageState(): PageState {
    return { entries: [], working: false, queuedPrompts: [] };
}

export function beginPageTurn(state: PageState, prompt: string): PageState {
    return {
        entries: [...state.entries, { kind: "user", text: prompt }],
        working: true,
        queuedPrompts: state.queuedPrompts,
    };
}

export function queuePagePrompt(state: PageState, prompt: string): PageState {
    return {
        ...state,
        queuedPrompts: [...state.queuedPrompts, prompt],
    };
}

export function beginNextQueuedPageTurn(state: PageState): PageState {
    const [prompt, ...queuedPrompts] = state.queuedPrompts;
    if (prompt === undefined) {
        return state;
    }

    return {
        entries: [...state.entries, { kind: "user", text: prompt }],
        working: true,
        queuedPrompts,
    };
}

export function renderQueuedPrompts(queuedPrompts: readonly string[]): string {
    const prompt = queuedPrompts[0];
    if (prompt === undefined) {
        return "";
    }

    const summary = prompt.replace(/\s+/g, " ").trim();
    const compact = summary.length > 48
        ? `${summary.slice(0, 47)}…`
        : summary;
    const remaining = queuedPrompts.length - 1;
    return `queued · ${compact}${remaining === 0 ? "" : ` · +${remaining}`}`;
}

export function applyPageFrame(state: PageState, frame: AgentFrame): PageState {
    if (frame.type === "assistant_delta") {
        return appendAssistantText(state, frame.text);
    }
    if (frame.type === "tool_started") {
        return appendEntry(state, {
            kind: "tool",
            text: `∗ ${formatToolCall(frame.tool, frame.args)}`,
        });
    }
    if (frame.type === "turn_finished") {
        return { ...state, working: false };
    }
    if (frame.type === "status") {
        return { ...state, working: frame.state !== "idle" };
    }
    return state;
}

export function appendPageNotice(state: PageState, message: string): PageState {
    return appendEntry(state, { kind: "notice", text: message });
}

function appendAssistantText(state: PageState, text: string): PageState {
    const entries = [...state.entries];
    const lastEntry = entries.at(-1);

    if (lastEntry?.kind === "assistant") {
        entries[entries.length - 1] = {
            kind: "assistant",
            text: lastEntry.text + text,
        };
    } else {
        entries.push({ kind: "assistant", text });
    }

    return { ...state, entries };
}

function appendEntry(state: PageState, entry: TranscriptEntry): PageState {
    return { ...state, entries: [...state.entries, entry] };
}

function formatToolCall(
    tool: string,
    args: Readonly<Record<string, unknown>>,
): string {
    const summary = Object.values(args)
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    if (summary.length === 0) {
        return tool;
    }
    return `${tool} ${summary.length > 64 ? `${summary.slice(0, 63)}…` : summary}`;
}
