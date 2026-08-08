import { describe, expect, test } from "bun:test";

import {
    DriveRecorder,
    effectiveThresholds,
    hasBudgetOverride,
    parseArgs,
    parsePrompts,
} from "../../dev/compaction/report.ts";
import {
    COMPACTION_TRIGGER_FRACTION,
    MIN_SUMMARY_TOKENS,
    POST_COMPACTION_TARGET_FRACTION,
    RETAINED_USER_TURNS,
    UNKNOWN_CAPACITY_TARGET_FRACTION,
} from "../../src/engine/compaction-scheduler.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";

const REQUIRED = [
    "--provider",
    "openrouter",
    "--model",
    "some/model",
    "--prompts",
    "prompts.txt",
];

describe("parseArgs", () => {
    test("defaults to the catalog capacity and a mode that cannot run tools", () => {
        expect(parseArgs(REQUIRED)).toEqual({
            provider: "openrouter",
            model: "some/model",
            promptsPath: "prompts.txt",
            capacity: { mode: "catalog" },
            budget: {},
            approvalMode: "ask",
        });
    });

    test("reads the optional flags", () => {
        expect(parseArgs([
            ...REQUIRED,
            "--capacity",
            "8000",
            "--approval",
            "full_access",
            "--effort",
            "low",
            "--session-path",
            "/tmp/s.jsonl",
        ])).toEqual({
            provider: "openrouter",
            model: "some/model",
            promptsPath: "prompts.txt",
            capacity: { mode: "fixed", tokens: 8000 },
            budget: {},
            approvalMode: "full_access",
            effort: "low",
            sessionPath: "/tmp/s.jsonl",
        });
    });

    test("accepts an unknown capacity", () => {
        expect(parseArgs([...REQUIRED, "--capacity", "unknown"]).capacity)
            .toEqual({ mode: "unknown" });
    });

    test("collects the budget knobs", () => {
        expect(parseArgs([
            ...REQUIRED,
            "--trigger-tokens",
            "3000",
            "--trigger-fraction",
            "0.5",
            "--target-tokens",
            "900",
        ]).budget).toEqual({
            triggerFraction: 0.5,
            triggerTokens: 3000,
            targetTokens: 900,
        });
    });

    test("rejects a budget knob outside its range", () => {
        expect(() => parseArgs([...REQUIRED, "--trigger-tokens", "0"]))
            .toThrow();
        expect(() => parseArgs([...REQUIRED, "--target-tokens", "-1"]))
            .toThrow();
        expect(() => parseArgs([...REQUIRED, "--trigger-fraction", "1.5"]))
            .toThrow();
        expect(() => parseArgs([...REQUIRED, "--trigger-fraction", "0"]))
            .toThrow();
    });

    test("rejects a capacity that is not a positive integer", () => {
        expect(() => parseArgs([...REQUIRED, "--capacity", "0"])).toThrow();
        expect(() => parseArgs([...REQUIRED, "--capacity", "1.5"])).toThrow();
    });

    test("rejects a missing required flag", () => {
        expect(() => parseArgs(["--provider", "openrouter"])).toThrow();
    });

    test("rejects an unrecognized flag", () => {
        expect(() => parseArgs([...REQUIRED, "--turns", "3"])).toThrow();
    });
});

describe("parsePrompts", () => {
    test("takes one prompt per line and drops blanks and comments", () => {
        expect(parsePrompts("first\n\n# a note\n  second  \n")).toEqual([
            "first",
            "second",
        ]);
    });

    test("rejects a script with no prompts", () => {
        expect(() => parsePrompts("\n# only a note\n")).toThrow();
    });
});

function measured(tokens: number, capacity: number): AgentUpdate {
    return {
        type: "context",
        measurement: { tokens, capacity, estimated: true },
        seq: 0,
    };
}

describe("DriveRecorder", () => {
    test("files a compaction under the turn it ran at the head of", () => {
        const recorder = new DriveRecorder(["one", "two"]);
        recorder.beginTurn();
        expect(recorder.observe(measured(900, 1000))).toBe(false);
        expect(recorder.observe({
            type: "turn_finished",
            seq: 1,
        })).toBe(true);

        recorder.beginTurn();
        expect(recorder.observe({
            type: "compaction",
            phase: "started",
            strategy: "vera/full-summary",
            seq: 2,
        })).toBe(false);
        recorder.observe({
            type: "compaction",
            phase: "finished",
            strategy: "vera/full-summary",
            outcome: "compacted",
            before: 900,
            after: 300,
            seq: 3,
        });
        recorder.observe(measured(320, 1000));
        recorder.observe({ type: "turn_finished", seq: 4 });

        const report = recorder.build({
            provider: "openrouter",
            model: "some/model",
            approval_mode: "ask",
            budget: {},
            capacity: { mode: "fixed", tokens: 1000 },
        });
        expect(report.turns[0]?.compactions).toEqual([]);
        expect(report.turns[1]).toEqual({
            index: 1,
            prompt: "two",
            outcome: "finished",
            context: { tokens: 320, capacity: 1000, estimated: true },
            compactions: [{
                strategy: "vera/full-summary",
                outcome: "compacted",
                before: 900,
                after: 300,
                context_before: { tokens: 900, capacity: 1000, estimated: true },
            }],
        });
        expect(report.summary).toEqual({
            turns: 2,
            compactions_attempted: 1,
            compactions_applied: 1,
        });
    });

    test("keeps a refused attempt with its reason and counts it as attempted", () => {
        const recorder = new DriveRecorder(["one"]);
        recorder.beginTurn();
        recorder.observe({
            type: "compaction",
            phase: "finished",
            strategy: "vera/full-summary",
            outcome: "no_boundary",
            reason: "nowhere to go",
            seq: 1,
        });
        recorder.observe({ type: "turn_finished", seq: 2 });
        const report = recorder.build({
            provider: "openrouter",
            model: "some/model",
            approval_mode: "ask",
            budget: {},
            capacity: { mode: "catalog" },
        });
        expect(report.turns[0]?.compactions[0]).toEqual({
            strategy: "vera/full-summary",
            outcome: "no_boundary",
            reason: "nowhere to go",
        });
        expect(report.summary.compactions_attempted).toBe(1);
        expect(report.summary.compactions_applied).toBe(0);
    });

    test("a failed turn ends the turn and carries its detail", () => {
        const recorder = new DriveRecorder(["one"]);
        recorder.beginTurn();
        expect(recorder.observe({
            type: "agent_failed",
            failureId: "f1",
            detail: "provider refused",
            seq: 1,
        })).toBe(true);
        const report = recorder.build({
            provider: "openrouter",
            model: "some/model",
            approval_mode: "ask",
            budget: {},
            capacity: { mode: "catalog" },
        });
        expect(report.turns[0]?.outcome).toBe("error");
        expect(report.turns[0]?.error).toBe("provider refused");
        expect(report.failure).toBe("provider refused");
    });

    test("reports the thresholds the outcomes are read against", () => {
        const report = new DriveRecorder([]).build({
            provider: "openrouter",
            model: "some/model",
            approval_mode: "ask",
            budget: {},
            capacity: { mode: "unknown" },
        });
        expect(report.thresholds).toEqual({
            trigger_fraction: 0.82,
            target_fraction: 0.45,
            unknown_capacity_target_fraction: 0.35,
            min_summary_tokens: 400,
            retained_user_turns: 2,
        });
    });
});

describe("effectiveThresholds", () => {
    test("falls back to the engine constants when nothing is configured", () => {
        expect(effectiveThresholds({})).toEqual({
            trigger_fraction: COMPACTION_TRIGGER_FRACTION,
            target_fraction: POST_COMPACTION_TARGET_FRACTION,
            unknown_capacity_target_fraction: UNKNOWN_CAPACITY_TARGET_FRACTION,
            min_summary_tokens: MIN_SUMMARY_TOKENS,
            retained_user_turns: RETAINED_USER_TURNS,
        });
    });

    test("reports the configured knobs in place of the constants", () => {
        expect(effectiveThresholds({
            triggerFraction: 0.5,
            triggerTokens: 3000,
            targetTokens: 900,
        })).toMatchObject({
            trigger_fraction: 0.5,
            trigger_tokens: 3000,
            target_tokens: 900,
        });
    });

    test("omits a knob that was not configured", () => {
        expect(effectiveThresholds({ triggerTokens: 3000 }))
            .not.toHaveProperty("target_tokens");
    });
});

describe("hasBudgetOverride", () => {
    test("is false only when every knob is absent", () => {
        expect(hasBudgetOverride({})).toBe(false);
        expect(hasBudgetOverride({ triggerTokens: 1 })).toBe(true);
        expect(hasBudgetOverride({ triggerFraction: 0.5 })).toBe(true);
        expect(hasBudgetOverride({ targetTokens: 900 })).toBe(true);
    });
});
