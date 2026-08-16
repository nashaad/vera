/**
 * Parses options and builds the JSON report for the developer compaction
 * harness in `drive.ts`. It is separate so these parts can be tested without
 * calling a model provider.
 */

import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { CompactionBudget } from "../../src/engine/compaction-scheduler.ts";
import {
    COMPACTION_TRIGGER_FRACTION,
    compactionBudgetWarning,
    MIN_SUMMARY_TOKENS,
    POST_COMPACTION_TARGET_FRACTION,
    RETAINED_USER_TURNS,
    UNKNOWN_CAPACITY_TARGET_FRACTION,
} from "../../src/engine/compaction-scheduler.ts";

/** `unknown` leaves the session with no window, which no fraction can trigger. */
export type CapacityOverride =
    | { readonly mode: "catalog" }
    | { readonly mode: "unknown" }
    | { readonly mode: "fixed"; readonly tokens: number };

/**
 * The profile knobs, as configured. Empty means the session binds the way an
 * unconfigured one does.
 */
export interface BudgetOverrides {
    readonly triggerFraction?: number;
    readonly triggerTokens?: number;
    readonly targetTokens?: number;
}

export function hasBudgetOverride(budget: BudgetOverrides): boolean {
    return budget.triggerFraction !== undefined
        || budget.triggerTokens !== undefined
        || budget.targetTokens !== undefined;
}

export interface DriveArgs {
    readonly provider: string;
    readonly model: string;
    readonly promptsPath: string;
    readonly capacity: CapacityOverride;
    readonly budget: BudgetOverrides;
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
    let triggerFraction: number | undefined;
    let triggerTokens: number | undefined;
    let targetTokens: number | undefined;
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
        } else if (flag === "--trigger-fraction" && value !== undefined) {
            triggerFraction = parseFraction(flag, value);
            index += 1;
        } else if (flag === "--trigger-tokens" && value !== undefined) {
            triggerTokens = parsePositiveInteger(flag, value);
            index += 1;
        } else if (flag === "--target-tokens" && value !== undefined) {
            targetTokens = parsePositiveInteger(flag, value);
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
        budget: {
            ...(triggerFraction === undefined ? {} : { triggerFraction }),
            ...(triggerTokens === undefined ? {} : { triggerTokens }),
            ...(targetTokens === undefined ? {} : { targetTokens }),
        },
        approvalMode,
        ...(effort === undefined ? {} : { effort }),
        ...(sessionPath === undefined ? {} : { sessionPath }),
    };
}

export function usage(): string {
    return "usage: bun run dev/compaction/drive.ts"
        + " --provider <provider> --model <id> --prompts <file|->"
        + " [--capacity <tokens|unknown>] [--trigger-tokens <n>]"
        + " [--trigger-fraction <0..1>] [--target-tokens <n>]"
        + " [--approval <mode>] [--effort <level>] [--session-path <path>]";
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

function parsePositiveInteger(flag: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} takes a positive integer`);
    }
    return parsed;
}

function parseFraction(flag: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error(`${flag} takes a fraction above 0 and at most 1`);
    }
    return parsed;
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

/**
 * What the run's outcomes are read against: the configured knob where one was
 * given, the engine's own constant where none was.
 *
 * `target_tokens` is reported as configured, not as applied. The scheduler
 * consults it only when the window is unknown, so a run that sets it against a
 * known window will show it here and still land on `target_fraction`.
 */
export interface EffectiveThresholds {
    readonly trigger_fraction: number;
    readonly trigger_tokens?: number;
    readonly target_fraction: number;
    readonly target_tokens?: number;
    readonly unknown_capacity_target_fraction: number;
    readonly min_summary_tokens: number;
    readonly retained_user_turns: number;
}

export function effectiveThresholds(
    budget: BudgetOverrides,
): EffectiveThresholds {
    return {
        trigger_fraction: budget.triggerFraction ?? COMPACTION_TRIGGER_FRACTION,
        ...(budget.triggerTokens === undefined
            ? {}
            : { trigger_tokens: budget.triggerTokens }),
        target_fraction: POST_COMPACTION_TARGET_FRACTION,
        ...(budget.targetTokens === undefined
            ? {}
            : { target_tokens: budget.targetTokens }),
        unknown_capacity_target_fraction: UNKNOWN_CAPACITY_TARGET_FRACTION,
        min_summary_tokens: MIN_SUMMARY_TOKENS,
        retained_user_turns: RETAINED_USER_TURNS,
    };
}

export interface DriveReport {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
    readonly approval_mode: string;
    readonly capacity: CapacityOverride;
    readonly thresholds: EffectiveThresholds;
    /**
     * The engine's own warning that the configured budget cannot pay for
     * itself, verbatim, or null when there is none.
     *
     * Taken from the `compaction` update when a compaction ran, which is the
     * only time the engine emits it. A run that configured the mismatch but
     * never crossed the trigger has no update to read, so the same exported
     * check is applied to the last measurement instead: the trap is a fact
     * about the configuration, and a scenario that never fired it is exactly
     * the one that would otherwise look green.
     */
    readonly budget_warning: string | null;
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
    private budgetWarning: string | undefined;

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
        if (update.type === "compaction" && update.phase === "started") {
            if (update.warning !== undefined) {
                this.budgetWarning = update.warning;
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
        readonly budget: BudgetOverrides;
        /** What was bound, for the warning the engine never got to emit. */
        readonly bound?: CompactionBudget;
        readonly session_path?: string;
    }): DriveReport {
        const { budget, bound, ...rest } = header;
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
            ...rest,
            thresholds: effectiveThresholds(budget),
            budget_warning: this.budgetWarning
                ?? (this.context === undefined
                    ? undefined
                    : compactionBudgetWarning(this.context, bound))
                ?? null,
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
