/**
 * Argument parsing and stdout shaping for `drive.ts`, kept separate so both
 * can be tested without a provider.
 */

import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    COMPACTION_TRIGGER_FRACTION,
    MIN_SUMMARY_TOKENS,
    POST_COMPACTION_TARGET_FRACTION,
    RETAINED_USER_TURNS,
} from "../../src/engine/compaction-scheduler.ts";

/** `unknown` leaves the session with no window, which no fraction can trigger. */
export type CapacityOverride =
    | { readonly mode: "catalog" }
    | { readonly mode: "unknown" }
    | { readonly mode: "fixed"; readonly tokens: number };

export interface DriveArgs {
    readonly provider: string;
    readonly model: string;
    readonly promptsPath: string;
    readonly capacity: CapacityOverride;
    readonly approvalMode: string;
    readonly effort?: string;
    readonly sessionPath?: string;
}

export function parseArgs(argv: readonly string[]): DriveArgs {
    let provider: string | undefined;
    let model: string | undefined;
    let promptsPath: string | undefined;
    let capacity: CapacityOverride = { mode: "catalog" };
    let approvalMode = "ask";
    let effort: string | undefined;
    let sessionPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (flag === "--provider" && value !== undefined) {
            provider = value;
            index += 1;
        } else if (flag === "--model" && value !== undefined) {
            model = value;
            index += 1;
        } else if (flag === "--prompts" && value !== undefined) {
            promptsPath = value;
            index += 1;
        } else if (flag === "--capacity" && value !== undefined) {
            capacity = parseCapacity(value);
            index += 1;
        } else if (flag === "--approval" && value !== undefined) {
            approvalMode = value;
            index += 1;
        } else if (flag === "--effort" && value !== undefined) {
            effort = value;
            index += 1;
        } else if (flag === "--session-path" && value !== undefined) {
            sessionPath = value;
            index += 1;
        } else {
            throw new Error(`unrecognized argument: ${flag}`);
        }
    }
    if (
        provider === undefined || model === undefined
        || promptsPath === undefined
    ) {
        throw new Error(usage());
    }
    return {
        provider,
        model,
        promptsPath,
        capacity,
        approvalMode,
        ...(effort === undefined ? {} : { effort }),
        ...(sessionPath === undefined ? {} : { sessionPath }),
    };
}

export function usage(): string {
    return "usage: bun run dev/compaction/drive.ts"
        + " --provider <provider> --model <id> --prompts <file|->"
        + " [--capacity <tokens|unknown>] [--approval <mode>]"
        + " [--effort <level>] [--session-path <path>]";
}

function parseCapacity(value: string): CapacityOverride {
    if (value === "unknown") {
        return { mode: "unknown" };
    }
    const tokens = Number(value);
    if (!Number.isInteger(tokens) || tokens <= 0) {
        throw new Error(`--capacity takes a positive integer or "unknown"`);
    }
    return { mode: "fixed", tokens };
}

/** One prompt per line. Blank lines and `#` lines are skipped. */
export function parsePrompts(text: string): readonly string[] {
    const prompts = text.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (prompts.length === 0) {
        throw new Error("the prompt script is empty");
    }
    return prompts;
}

export interface CompactionAttemptReport {
    readonly strategy: string;
    readonly outcome: string;
    readonly reason?: string;
    readonly before?: number;
    readonly after?: number;
    /**
     * The last request the engine measured before this attempt. The trigger
     * comparison itself is not emitted, and this is the reading it is derived
     * from, carried forward over the messages added since.
     */
    readonly context_before?: ContextMeasurement;
}

export interface TurnReport {
    readonly index: number;
    readonly prompt: string;
    readonly outcome: string;
    readonly error?: string;
    readonly empty?: true;
    readonly context?: ContextMeasurement;
    readonly compactions: readonly CompactionAttemptReport[];
}

export interface DriveReport {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
    readonly approval_mode: string;
    readonly capacity: CapacityOverride;
    readonly thresholds: {
        readonly trigger_fraction: number;
        readonly target_fraction: number;
        readonly min_summary_tokens: number;
        readonly retained_user_turns: number;
    };
    readonly session_path?: string;
    readonly turns: readonly TurnReport[];
    readonly summary: {
        readonly turns: number;
        readonly compactions_attempted: number;
        readonly compactions_applied: number;
    };
    /** Present only when the driver itself could not finish the script. */
    readonly failure?: string;
}

interface MutableTurn {
    outcome: string;
    error?: string;
    empty?: true;
    context?: ContextMeasurement;
    readonly compactions: CompactionAttemptReport[];
}

/**
 * Folds the update stream into the document. The engine emits a compaction
 * pair only when the trigger fired, so a turn with no attempt reports an
 * empty list rather than a "not needed" row.
 *
 * Turns are opened by the driver as it releases each prompt, not by the
 * `user_prompt` update: compaction runs before the prompt is committed, so a
 * record opened on that update would file the attempt under the turn before.
 */
export class DriveRecorder {
    private readonly turns: MutableTurn[] = [];
    private context: ContextMeasurement | undefined;
    private failure: string | undefined;

    constructor(private readonly prompts: readonly string[]) {}

    beginTurn(): void {
        this.turns.push({ outcome: "running", compactions: [] });
    }

    /** True when the update ended a turn, which is when the next prompt goes. */
    observe(update: AgentUpdate): boolean {
        const turn = this.turns[this.turns.length - 1];
        if (update.type === "context") {
            this.context = update.measurement;
            if (turn !== undefined) {
                turn.context = update.measurement;
            }
            return false;
        }
        if (update.type === "compaction" && update.phase === "finished") {
            turn?.compactions.push({
                strategy: update.strategy,
                outcome: update.outcome ?? "unknown",
                ...(update.reason === undefined
                    ? {}
                    : { reason: update.reason }),
                ...(update.before === undefined
                    ? {}
                    : { before: update.before }),
                ...(update.after === undefined ? {} : { after: update.after }),
                ...(this.context === undefined
                    ? {}
                    : { context_before: this.context }),
            });
            return false;
        }
        if (update.type === "turn_finished") {
            if (turn !== undefined) {
                turn.outcome = update.outcome ?? "finished";
                if (update.error !== undefined) {
                    turn.error = update.error;
                }
                if (update.empty === true) {
                    turn.empty = true;
                }
            }
            return true;
        }
        if (update.type === "agent_failed") {
            this.failure = update.detail;
            if (turn !== undefined) {
                turn.outcome = "error";
                turn.error = update.detail;
            }
            return true;
        }
        return false;
    }

    fail(detail: string): void {
        this.failure = detail;
    }

    build(header: {
        readonly provider: string;
        readonly model: string;
        readonly effort?: string;
        readonly approval_mode: string;
        readonly capacity: CapacityOverride;
        readonly session_path?: string;
    }): DriveReport {
        const turns = this.turns.map((turn, index) => ({
            index,
            prompt: this.prompts[index] ?? "",
            outcome: turn.outcome,
            ...(turn.error === undefined ? {} : { error: turn.error }),
            ...(turn.empty === undefined ? {} : { empty: turn.empty }),
            ...(turn.context === undefined ? {} : { context: turn.context }),
            compactions: turn.compactions,
        }));
        const attempts = turns.flatMap((turn) => turn.compactions);
        return {
            ...header,
            thresholds: {
                trigger_fraction: COMPACTION_TRIGGER_FRACTION,
                target_fraction: POST_COMPACTION_TARGET_FRACTION,
                min_summary_tokens: MIN_SUMMARY_TOKENS,
                retained_user_turns: RETAINED_USER_TURNS,
            },
            turns,
            summary: {
                turns: turns.length,
                compactions_attempted: attempts.length,
                compactions_applied: attempts.filter(
                    (attempt) => attempt.outcome === "compacted",
                ).length,
            },
            ...(this.failure === undefined ? {} : { failure: this.failure }),
        };
    }
}
