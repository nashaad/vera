import type { VeraClientExtensionOneshot } from "../../../src/sdk/extensions.ts";
import {
    measureDeepPile,
    type DeepPileMeasurement,
    type DeepPileSnapshot,
} from "./deep-pile.ts";
import {
    judgeDeep,
    type JudgeState,
    type OneshotModel,
} from "./deep-judge.ts";

export const INSTRUCTION_BUDGET = 150;
export const HARNESS_INSTRUCTIONS = 50;

export interface UnmeasuredDroppedRule {
    readonly status: "unmeasured";
}

export interface ContextDeepReport {
    readonly pile: DeepPileSnapshot;
    readonly harnessInstructions: number;
    readonly instructionBudget: number;
    readonly judge: JudgeState;
    readonly droppedRule: UnmeasuredDroppedRule;
}

export interface BuildContextDeepOptions {
    readonly workspace: string;
    readonly oneshot?: VeraClientExtensionOneshot;
    readonly model?: OneshotModel;
}

/**
 * Pile counts are local. Distinct / families / SDE wait on an isolated
 * oneshot. Dropped-rule stays unmeasured until a later probe.
 */
export async function buildContextDeep(
    options: BuildContextDeepOptions,
): Promise<ContextDeepReport> {
    const measurement = await measureDeepPile(options.workspace);
    return {
        pile: measurement.pile,
        harnessInstructions: HARNESS_INSTRUCTIONS,
        instructionBudget: INSTRUCTION_BUDGET,
        judge: await resolveJudge(measurement, options),
        droppedRule: { status: "unmeasured" },
    };
}

async function resolveJudge(
    measurement: DeepPileMeasurement,
    options: BuildContextDeepOptions,
): Promise<JudgeState> {
    if (options.oneshot === undefined) {
        return {
            status: "unmeasured",
            reason: "oneshot is not available",
        };
    }
    if (options.model === undefined) {
        return {
            status: "unmeasured",
            reason: "no model is configured",
        };
    }
    return judgeDeep(measurement.bodies, options.oneshot, options.model);
}
