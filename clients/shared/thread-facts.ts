import type { AgentUpdate, TranscriptEntry } from "../../src/engine/protocol.ts";
import type { ToolPresentation } from "../../src/model/types.ts";
import type { VeraClientThreadEntry } from "../../src/sdk/extensions.ts";

// The last checkpoint, plus what streamed after it. The next checkpoint replaces both.
export interface ThreadFacts {
    readonly stored: readonly VeraClientThreadEntry[];
    readonly live: readonly VeraClientThreadEntry[];
}

export const EMPTY_THREAD_FACTS: ThreadFacts = { stored: [], live: [] };

export function threadFactEntries(facts: ThreadFacts): readonly VeraClientThreadEntry[] {
    return facts.live.length === 0 ? facts.stored : [...facts.stored, ...facts.live];
}

/** Returns the same object when the update says nothing about the thread. */
export function applyThreadUpdate(
    facts: ThreadFacts,
    update: AgentUpdate,
    now: number,
): ThreadFacts {
    switch (update.type) {
        case "history":
            return { stored: projectStoredEntries(update.entries), live: [] };
        case "user_prompt":
            return appendLive(facts, { kind: "user", text: update.content, at: now });
        case "assistant_delta":
            return appendAssistantText(facts, update.text, now);
        case "model_activity":
            return update.replacesPartialAttempt === true ? dropPartialAnswer(facts) : facts;
        case "tool_started":
            return appendLive(facts, { kind: "tool_call", tool: update.tool, args: update.args, at: now });
        case "tool_finished":
            return appendLive(facts, {
                kind: "tool_result",
                tool: update.tool,
                output: update.output ?? "",
                isError: update.isError ?? false,
                at: now,
            });
        case "tool_presentation": {
            const entry = presentationEntry(update.presentation);
            return entry === undefined ? facts : appendLive(facts, { ...entry, at: now });
        }
        case "turn_finished": {
            const timed = update.turnTiming === undefined
                ? facts
                : { ...facts, live: withTurnDuration(facts.live, update.turnTiming.durationMs) };
            return update.outcome === undefined
                ? timed
                : appendLive(timed, { kind: "failure", outcome: update.outcome, at: now });
        }
        case "agent_failed":
            return appendLive(facts, { kind: "failure", outcome: "error", at: now });
        default:
            return facts;
    }
}

export function projectStoredEntries(
    entries: readonly TranscriptEntry[],
): readonly VeraClientThreadEntry[] {
    const projected: VeraClientThreadEntry[] = [];
    for (const entry of entries) {
        const fact = storedFact(entry);
        if (fact !== undefined) {
            projected.push({
                ...fact,
                ...(entry.id === undefined ? {} : { id: entry.id }),
                ...(entry.recordedAt === undefined ? {} : { at: entry.recordedAt }),
            });
        }
        // A turn can end on an entry with no fact, so its duration moves back to the last one that has one.
        if (entry.turnTiming !== undefined && projected.length > 0) {
            projected.splice(-1, 1, { ...projected.at(-1)!, turnDurationMs: entry.turnTiming.durationMs });
        }
    }
    return projected;
}

type UntimedFact = DistributiveOmit<VeraClientThreadEntry, "id" | "at" | "turnDurationMs">;
// Plain Omit on a union keeps only the fields every member shares.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function storedFact(entry: TranscriptEntry): UntimedFact | undefined {
    switch (entry.kind) {
        case "user":
            return { kind: "user", text: entry.text };
        case "assistant":
            return entry.text.length === 0 ? undefined : { kind: "assistant", text: entry.text };
        case "tool":
            return { kind: "tool_call", tool: entry.tool, args: entry.args };
        case "tool_result":
            return { kind: "tool_result", tool: entry.tool, output: entry.output, isError: entry.isError };
        case "presentation":
            return presentationEntry(entry.presentation);
        case "error":
            return { kind: "failure", outcome: entry.outcome ?? "error" };
        default:
            return undefined;
    }
}

function presentationEntry(presentation: ToolPresentation): UntimedFact | undefined {
    if (presentation.kind === "unified_diff") {
        return presentation.scratch === true ? undefined : { kind: "edit", path: presentation.path };
    }
    if (presentation.kind === "checklist") {
        return {
            kind: "checklist",
            path: presentation.path,
            items: presentation.items.map((item) => ({
                text: item.text,
                done: item.done,
                ...(item.justDone === true ? { justDone: true as const } : {}),
            })),
        };
    }
    return undefined;
}

function appendLive(facts: ThreadFacts, entry: VeraClientThreadEntry): ThreadFacts {
    return { ...facts, live: [...facts.live, entry] };
}

function appendAssistantText(facts: ThreadFacts, text: string, now: number): ThreadFacts {
    const last = facts.live.at(-1);
    if (last?.kind !== "assistant") return appendLive(facts, { kind: "assistant", text, at: now });
    return { ...facts, live: [...facts.live.slice(0, -1), { ...last, text: last.text + text }] };
}

function dropPartialAnswer(facts: ThreadFacts): ThreadFacts {
    return facts.live.at(-1)?.kind === "assistant"
        ? { ...facts, live: facts.live.slice(0, -1) }
        : facts;
}

function withTurnDuration(
    live: readonly VeraClientThreadEntry[],
    durationMs: number,
): readonly VeraClientThreadEntry[] {
    const last = live.at(-1);
    return last === undefined ? live : [...live.slice(0, -1), { ...last, turnDurationMs: durationMs }];
}
