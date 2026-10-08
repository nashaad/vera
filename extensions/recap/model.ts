import type {
    VeraClientRevealTarget,
    VeraClientThreadEntry,
    VeraClientThreadToolCall,
    VeraClientThreadToolResult,
} from "../../src/sdk/extensions.ts";

const SHORT_REPLY_WORDS = 3;
const ASIDE_MAX_MS = 2 * 60_000;
const IDLE_BREAK_MS = 30 * 60_000;
const LONG_STEP_MS = 5 * 60_000;
const SHARE_STEP_MIN_MS = 60_000;
const TITLE_MAX_CHARS = 48;

export type RecapMarkKind = "aside" | "commit" | "question" | "long_step" | "failure";

/** Something worth its own row under a phase, in time order. */
export interface RecapMark {
    readonly kind: RecapMarkKind;
    readonly text: string;
    readonly at?: number;
    /** A long step's length, or how long a question waited. */
    readonly durationMs?: number;
    /** A commit's short hash. */
    readonly ref?: string;
    readonly target: VeraClientRevealTarget;
}

export interface RecapPhase {
    readonly title: string;
    readonly startedAt?: number;
    /** Time spent working, without the idle time between turns. */
    readonly activeMs: number;
    readonly toolCalls: number;
    readonly editedPaths: readonly string[];
    readonly tests?: "passed" | "failed";
    readonly running: boolean;
    readonly target: VeraClientRevealTarget;
    readonly marks: readonly RecapMark[];
}

interface Chunk {
    readonly entries: readonly VeraClientThreadEntry[];
    readonly startedAt?: number;
    readonly closedItem?: string;
    readonly openItem?: string;
}

interface ToolStep {
    readonly call: VeraClientThreadToolCall;
    readonly result?: VeraClientThreadToolResult;
}

interface Group {
    readonly chunks: Chunk[];
    readonly asides: RecapMark[];
}

/** Groups a thread into phases. `now` closes the running turn. */
export function buildRecap(entries: readonly VeraClientThreadEntry[], now: number): RecapPhase[] {
    const groups: Group[] = [];
    for (const chunk of chunks(entries)) {
        if (chunk.entries[0]?.kind === "user") foldAside(groups, now);
        const current = groups.at(-1);
        if (current !== undefined && continuesGroup(current, chunk)) {
            current.chunks.push(chunk);
            continue;
        }
        groups.push({ chunks: [chunk], asides: [] });
    }
    foldAside(groups, now);
    const phases: RecapPhase[] = [];
    for (const group of groups) {
        const phase = buildPhase(group.chunks, now);
        phases.push(group.asides.length === 0 ? phase : { ...phase, marks: byTime([...phase.marks, ...group.asides]) });
    }
    return phases;
}

function continuesGroup(group: Group, chunk: Chunk): boolean {
    const previous = group.chunks.at(-1)!;
    if (previous.closedItem !== undefined) return false;
    const first = chunk.entries[0];
    return first?.kind !== "user" || isShortReply(first.text, chunk.startedAt, lastAt(previous));
}

// A quick question with no edits or marks, asked in the middle of real work, folds into that work as one row.
function foldAside(groups: Group[], now: number): void {
    const last = groups.at(-1);
    const previous = groups.at(-2);
    if (last === undefined || previous === undefined) return;
    const candidate = buildPhase(last.chunks, now);
    if (!isAside(candidate)) return;
    if (buildPhase(previous.chunks, now).editedPaths.length === 0) return;
    previous.asides.push(asideMark(candidate));
    groups.pop();
}

// A turn is cut after each checklist write that ticks an item, so one long run reads as the steps it finished.
function chunks(entries: readonly VeraClientThreadEntry[]): Chunk[] {
    const result: Chunk[] = [];
    let current: VeraClientThreadEntry[] = [];
    let startedAt: number | undefined;
    let openItem: string | undefined;
    const close = (closedItem?: string): void => {
        if (current.length === 0) return;
        result.push({
            entries: current,
            ...(startedAt === undefined ? {} : { startedAt }),
            ...(closedItem === undefined ? {} : { closedItem }),
            ...(openItem === undefined ? {} : { openItem }),
        });
        startedAt = current.at(-1)?.at;
        current = [];
    };
    for (const entry of entries) {
        if (entry.kind === "user") {
            close();
            startedAt = entry.at;
        }
        if (current.length === 0 && startedAt === undefined) startedAt = entry.at;
        current.push(entry);
        if (entry.kind === "checklist") {
            const ticked = entry.items.filter((item) => item.justDone === true).map((item) => item.text);
            const nextOpen = entry.items.find((item) => !item.done)?.text;
            if (ticked.length > 0) {
                close(ticked.length === 1 ? ticked[0] : `${ticked[0]} (+${ticked.length - 1})`);
            }
            openItem = nextOpen;
        }
    }
    close();
    return result;
}

function buildPhase(chunks: readonly Chunk[], now: number): RecapPhase {
    const entries = chunks.flatMap((chunk) => chunk.entries);
    const running = entries.some((entry) => entry.id === undefined);
    const activeMs = chunks.reduce((sum, chunk, index) => {
        const start = chunk.startedAt;
        const isLast = index === chunks.length - 1;
        const end = isLast && running ? now : lastAt(chunk);
        return start === undefined || end === undefined ? sum : sum + Math.max(0, end - start);
    }, 0);
    const steps = pairSteps(entries);
    const editedPaths = [...new Set(entries.flatMap((entry) => entry.kind === "edit" ? [entry.path] : []))];
    const tests = testOutcome(steps);
    const first = chunks[0]!;
    const userText = first.entries[0]?.kind === "user" ? first.entries[0].text : undefined;
    const closedItem = chunks.at(-1)?.closedItem;
    const title = closedItem
        ?? (userText !== undefined && !isShortReply(userText) ? shorten(userText) : undefined)
        ?? first.openItem
        ?? (userText === undefined ? "Session start" : shorten(userText));
    return {
        title,
        ...(first.startedAt === undefined ? {} : { startedAt: first.startedAt }),
        activeMs,
        toolCalls: steps.length,
        editedPaths,
        ...(tests === undefined ? {} : { tests }),
        running,
        target: targetOf(entries),
        marks: marksOf(entries, steps, activeMs, now),
    };
}

function marksOf(
    entries: readonly VeraClientThreadEntry[],
    steps: readonly ToolStep[],
    activeMs: number,
    now: number,
): RecapMark[] {
    const marks: RecapMark[] = [];
    for (const step of steps) {
        const target = step.call.id === undefined ? END : { entryId: step.call.id };
        const durationMs = stepDuration(step, now);
        const commit = step.result === undefined ? undefined : parseCommit(step.result);
        if (step.call.tool === "ask_user") {
            const question = typeof step.call.args.question === "string" ? step.call.args.question : "a question";
            marks.push(mark("question", shorten(question), step.call.at, target, durationMs));
        } else if (commit !== undefined) {
            marks.push({ ...mark("commit", commit.message, step.result!.at, target), ref: commit.ref });
        } else if (
            durationMs !== undefined
            && (durationMs >= LONG_STEP_MS || (durationMs >= SHARE_STEP_MIN_MS && durationMs * 3 >= activeMs))
        ) {
            marks.push(mark("long_step", stepLabel(step.call), step.call.at, target, durationMs));
        }
    }
    for (const entry of entries) {
        if (entry.kind !== "failure") continue;
        const target = entry.id === undefined ? END : { entryId: entry.id };
        marks.push(mark("failure", entry.outcome === "aborted" ? "Interrupted" : "Turn failed", entry.at, target));
    }
    return byTime(marks);
}

function byTime(marks: RecapMark[]): RecapMark[] {
    return marks.sort((left, right) => (left.at ?? Infinity) - (right.at ?? Infinity));
}

function mark(
    kind: RecapMarkKind,
    text: string,
    at: number | undefined,
    target: VeraClientRevealTarget,
    durationMs?: number,
): RecapMark {
    return {
        kind,
        text,
        ...(at === undefined ? {} : { at }),
        ...(durationMs === undefined ? {} : { durationMs }),
        target,
    };
}

const END: VeraClientRevealTarget = { end: true };

function pairSteps(entries: readonly VeraClientThreadEntry[]): ToolStep[] {
    const steps: { call: VeraClientThreadToolCall; result?: VeraClientThreadToolResult }[] = [];
    for (const entry of entries) {
        if (entry.kind === "tool_call") steps.push({ call: entry });
        if (entry.kind === "tool_result") {
            const waiting = steps.find((step) => step.result === undefined && step.call.tool === entry.tool);
            if (waiting !== undefined) waiting.result = entry;
        }
    }
    return steps;
}

function stepDuration(step: ToolStep, now: number): number | undefined {
    const start = step.call.at;
    const end = step.result === undefined ? (step.call.id === undefined ? now : undefined) : step.result.at;
    return start === undefined || end === undefined ? undefined : Math.max(0, end - start);
}

const TEST_COMMAND = /\b(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test|pytest|go\s+test|cargo\s+test|vitest|jest)\b/;

function testOutcome(steps: readonly ToolStep[]): "passed" | "failed" | undefined {
    let outcome: "passed" | "failed" | undefined;
    for (const step of steps) {
        if (step.call.tool !== "bash" || step.result === undefined) continue;
        if (!TEST_COMMAND.test(commandOf(step.call))) continue;
        outcome = step.result.isError ? "failed" : "passed";
    }
    return outcome;
}

// `git commit` prints `[branch sha] message`, with `(root-commit)` after the branch on a first commit.
const COMMIT_LINE = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/m;

export function parseCommit(result: VeraClientThreadToolResult): { ref: string; message: string } | undefined {
    if (result.tool !== "bash" || result.isError) return undefined;
    const match = COMMIT_LINE.exec(result.output);
    return match === null ? undefined : { ref: match[1]!, message: match[2]!.trim() };
}

function stepLabel(call: VeraClientThreadToolCall): string {
    if (call.tool === "bash") return shorten(commandOf(call));
    if (call.tool === "subagent") {
        const about = call.args.description ?? call.args.agent ?? call.args.name;
        return typeof about === "string" ? `subagent: ${shorten(about)}` : "subagent";
    }
    return call.tool;
}

function commandOf(call: VeraClientThreadToolCall): string {
    return typeof call.args.command === "string" ? call.args.command : "";
}

function isAside(phase: RecapPhase): boolean {
    return !phase.running
        && phase.editedPaths.length === 0
        && phase.tests === undefined
        && phase.marks.length === 0
        && phase.activeMs < ASIDE_MAX_MS;
}

function asideMark(phase: RecapPhase): RecapMark {
    return mark("aside", phase.title, phase.startedAt, phase.target, phase.activeMs);
}

function isShortReply(text: string, at?: number, previousAt?: number): boolean {
    if (at !== undefined && previousAt !== undefined && at - previousAt > IDLE_BREAK_MS) return false;
    return text.trim().split(/\s+/).filter(Boolean).length <= SHORT_REPLY_WORDS;
}

function lastAt(chunk: Chunk): number | undefined {
    for (let index = chunk.entries.length - 1; index >= 0; index--) {
        const at = chunk.entries[index]!.at;
        if (at !== undefined) return at;
    }
    return undefined;
}

// Tool results share a row with their call in the transcript, so they are never a jump target.
function targetOf(entries: readonly VeraClientThreadEntry[]): VeraClientRevealTarget {
    const first = entries.find((entry) => entry.kind !== "tool_result");
    return first?.id === undefined ? END : { entryId: first.id };
}

export function shorten(text: string): string {
    const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
    const flat = line.replace(/\s+/g, " ");
    if (flat.length <= TITLE_MAX_CHARS) return flat;
    const cut = flat.slice(0, TITLE_MAX_CHARS - 1);
    const space = cut.lastIndexOf(" ");
    return `${space > TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}
