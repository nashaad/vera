import type { ModelMessage, TextContent, UserContent } from "../model/types.ts";
import { measureMessages } from "./context-measurement.ts";
import {
    CompactionRejectedError,
    startsTurn,
    workingPrompt,
    type CompactionProposal,
    type CompactionStrategyDefinition,
} from "./compaction.ts";

export const DROP_OLDEST_STRATEGY_ID = "vera/drop-oldest";

export const dropOldestStrategy: CompactionStrategyDefinition = {
    id: DROP_OLDEST_STRATEGY_ID,
    models: [],
    keepsPrompt: true,
    compact: async (request) =>
        dropOldest(
            request.messages,
            request.targetTokens,
            request.previousProjectionCount ?? 0,
        ),
};

interface Entry {
    readonly index: number;
    readonly message: ModelMessage;
}

interface Turn {
    readonly start: number;
    readonly end: number;
    readonly kept: boolean;
    readonly whole: readonly Entry[];
    readonly opener: readonly Entry[];
    readonly steps: readonly (readonly Entry[])[];
}

interface Start {
    readonly index: number;
    readonly message: ModelMessage;
}

function dropOldest(
    messages: readonly ModelMessage[],
    targetTokens: number,
    previousCount: number,
): CompactionProposal {
    const working = workingPrompt(messages)?.index ?? -1;
    const turns = parseTurns(messages, working);
    const kept = turns.filter((turn) => turn.kept);
    if (kept.length === 0) {
        throw new CompactionRejectedError(
            "There is no whole turn to keep in the compacted span.",
        );
    }
    const fits = (entries: readonly Entry[]): boolean =>
        measureMessages(entries.map((entry) => entry.message)) <= targetTokens;
    const suffixFrom = (from: number): Entry[] =>
        kept.slice(from).flatMap((turn) => turn.whole);

    const first = firstFitting(kept.length, (from) => fits(suffixFrom(from)));
    const cut = kept[first - 1];
    if (cut === undefined) {
        return finish(suffixFrom(0), turns, undefined);
    }

    const suffix = suffixFrom(first);
    const unit = unitBefore(kept, cut, previousCount, turns);
    const headBefore = (tail: readonly Entry[]): Entry[] =>
        fits([...unit, ...tail]) ? unit : [];
    const jMax = Math.max(cut.steps.length - 1, 0);
    const build = (head: readonly Entry[], from: number): Entry[] => [
        ...head,
        ...cut.opener,
        ...cut.steps.slice(from).flat(),
        ...suffix,
    ];
    if (!fits(build([], jMax))) {
        if (first < kept.length) {
            return finish([...headBefore(suffix), ...suffix], turns, cut);
        }
        throw new CompactionRejectedError(
            "The newest turn's prompt and newest step do not fit the target.",
            true,
        );
    }
    const head = headBefore(build([], jMax));
    const from = firstFitting(jMax, (step) => fits(build(head, step)));
    return finish(build(head, from), turns, cut);
}

// The kept turns of the earlier projection. Turns after them and before the cut turn are dropped.
function unitBefore(
    kept: readonly Turn[],
    cut: Turn,
    previousCount: number,
    turns: readonly Turn[],
): Entry[] {
    const end = unitBoundary(Math.min(cut.start, previousCount), turns);
    return kept
        .filter((turn) => turn.start < end)
        .flatMap((turn) => turn.whole);
}

// A boundary inside a turn moves back to that turn's start, so a unit never keeps some of its steps.
function unitBoundary(limit: number, turns: readonly Turn[]): number {
    const split = turns.find((turn) => turn.start < limit && limit < turn.end);
    return split === undefined ? limit : split.start;
}

function finish(
    entries: readonly Entry[],
    turns: readonly Turn[],
    cut: Turn | undefined,
): CompactionProposal {
    const included = new Set(entries.map((entry) => entry.index));
    const wholeTurns = turns.filter((turn) => !included.has(turn.start)).length;
    const cutTurnSteps = cut !== undefined && included.has(cut.start)
        ? droppedSteps(cut, entries)
        : 0;
    return {
        projection: entries.map((entry) => entry.message),
        dropped: { wholeTurns, cutTurnSteps },
    };
}

// A steer that opens a range is not a step, so only assistant-headed steps are counted.
function droppedSteps(turn: Turn, entries: readonly Entry[]): number {
    const retained = new Set(entries.map((entry) => entry.index));
    return turn.steps.filter((step) =>
        step[0]?.message.role === "assistant"
            && step.every((entry) => !retained.has(entry.index))
    ).length;
}

function parseTurns(messages: readonly ModelMessage[], working: number): Turn[] {
    const seams = seamIndexes(messages);
    const starts: Start[] = [];
    messages.forEach((message, index) => {
        if (startsTurn(message)) {
            starts.push({ index, message });
        }
    });
    return starts.map((start, position) => {
        const end = starts[position + 1]?.index ?? messages.length;
        const kept = effectiveForm(start.message, start.index === working) !== undefined;
        if (!kept) {
            return { start: start.index, end, kept, whole: [], opener: [], steps: [] };
        }
        const stepStarts: number[] = [];
        for (let index = start.index + 1; index < end; index += 1) {
            if (seams.has(index)) {
                stepStarts.push(index);
            }
        }
        return {
            start: start.index,
            end,
            kept,
            whole: effectiveRange(messages, start.index, end, working),
            opener: effectiveRange(
                messages,
                start.index,
                stepStarts[0] ?? end,
                working,
            ),
            steps: stepStarts.map((from, step) =>
                effectiveRange(
                    messages,
                    from,
                    stepStarts[step + 1] ?? end,
                    working,
                )),
        };
    });
}

// A cut may start at a seam: an assistant message or a steer, while no tool call still awaits its result.
function seamIndexes(messages: readonly ModelMessage[]): Set<number> {
    const seams = new Set<number>();
    const awaiting = new Set<string>();
    messages.forEach((message, index) => {
        if (awaiting.size === 0 && isSeam(message)) {
            seams.add(index);
        }
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "tool_call") {
                    awaiting.add(block.id);
                }
            }
        } else if (message.role === "tool_result") {
            awaiting.delete(message.toolCallId);
        }
    });
    return seams;
}

function isSeam(message: ModelMessage): boolean {
    if (message.role === "assistant") {
        return true;
    }
    return message.role === "user"
        && message.arrivedDuringTurn === true
        && message.internal !== true;
}

// Words are kept and images dropped; a wordless message is dropped unless it is the working prompt.
function effectiveForm(
    message: ModelMessage,
    working: boolean,
): ModelMessage | undefined {
    if (message.role !== "user") {
        return message;
    }
    const words = message.content.filter(isText);
    if (words.length > 0) {
        return { ...message, content: words };
    }
    return working ? message : undefined;
}

function isText(block: UserContent): block is TextContent {
    return block.type === "text";
}

function effectiveRange(
    messages: readonly ModelMessage[],
    from: number,
    to: number,
    working: number,
): Entry[] {
    const entries: Entry[] = [];
    for (let index = from; index < to; index += 1) {
        const message = messages[index];
        const form = message === undefined
            ? undefined
            : effectiveForm(message, index === working);
        if (form !== undefined) {
            entries.push({ index, message: form });
        }
    }
    return entries;
}

// Fitting is false up to some candidate and true after it, so bisection finds the first that fits.
function firstFitting(high: number, fits: (candidate: number) => boolean): number {
    let low = 0;
    let top = high;
    while (low < top) {
        const middle = Math.floor((low + top) / 2);
        if (fits(middle)) {
            top = middle;
        } else {
            low = middle + 1;
        }
    }
    return low;
}
