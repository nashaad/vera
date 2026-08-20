import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ModelFailureLedger,
    countModelFailureSignature,
    modelFailureNudge,
    modelFailureSignature,
    readModelFailures,
    summariseModelFailures,
    type ModelFailureRecord,
} from "../../src/store/model-failures.ts";

function ledgerPath(): string {
    return join(
        mkdtempSync(join(tmpdir(), "vera-failures-")),
        "failures",
        "ledger.jsonl",
    );
}

function record(
    overrides: Partial<ModelFailureRecord> = {},
): ModelFailureRecord {
    return {
        at: "2026-08-19T14:00:00.000Z",
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        kind: "no_visible_response",
        detail: "Model returned no visible response or structured tool call.",
        sessionId: "session-a",
        ...overrides,
    };
}

test("a recorded failure survives being written and read back", () => {
    const path = ledgerPath();
    try {
        new ModelFailureLedger(path).record(record());
        expect(readModelFailures(path)).toEqual([record()]);
    } finally {
        rmSync(path, { force: true });
    }
});

test("failed request attribution survives being written and read back", () => {
    const path = ledgerPath();
    const attributed = record({
        requestTokens: 158_544,
        requestTokensEstimated: true,
        allowance: {
            kind: "prompt_tokens",
            requested: 158_544,
            available: 91_805,
        },
    });
    try {
        new ModelFailureLedger(path).record(attributed);
        expect(readModelFailures(path)).toEqual([attributed]);
    } finally {
        rmSync(path, { force: true });
    }
});

test("the same model failing the same way twice is one signature", () => {
    const records = [record(), record({ sessionId: "session-b" })];
    const summary = summariseModelFailures(records);
    expect(summary.total).toBe(2);
    expect(summary.signatures).toHaveLength(1);
    // Two sessions, so this survived a restart rather than being one bad run.
    expect(summary.signatures[0]?.count).toBe(2);
    expect(summary.signatures[0]?.sessions).toBe(2);
});

test("the same model failing two ways is two signatures", () => {
    const summary = summariseModelFailures([
        record(),
        record({ kind: "provider_failure" }),
    ]);
    expect(summary.signatures).toHaveLength(2);
});

// The provider is part of the identity because switching providers for the
// same model is one of the fixes a user can actually apply.
test("one model served by two providers counts separately", () => {
    expect(modelFailureSignature(record())).not.toBe(
        modelFailureSignature(record({ provider: "moonshot" })),
    );
});

test("the most repeated signature is reported first", () => {
    const summary = summariseModelFailures([
        record({ kind: "provider_failure" }),
        record(),
        record(),
    ]);
    expect(summary.signatures[0]?.kind).toBe("no_visible_response");
});

test("a failure summary carries the latest attempted request and allowance", () => {
    const summary = summariseModelFailures([
        record({ requestTokens: 100 }),
        record({
            requestTokens: 80_004,
            requestTokensEstimated: true,
            allowance: {
                kind: "prompt_tokens",
                requested: 80_004,
                available: 51_390,
            },
        }),
    ]);
    expect(summary.signatures[0]?.lastRequestTokens).toBe(80_004);
    expect(summary.signatures[0]?.lastRequestTokensEstimated).toBe(true);
    expect(summary.signatures[0]?.lastAllowance?.available).toBe(51_390);
});

test("a first failure is not nudged about", () => {
    const now = new Date("2026-08-19T14:00:01.000Z");
    expect(modelFailureNudge([record()], new Set(), now)).toBeUndefined();
});

test("a second identical failure is nudged about once", () => {
    const now = new Date("2026-08-19T14:00:01.000Z");
    const records = [record(), record()];
    const nudge = modelFailureNudge(records, new Set(), now);
    expect(nudge?.signature).toBe(modelFailureSignature(record()));
    expect(nudge?.text).toContain("openrouter/moonshotai/kimi-k3");
    expect(nudge?.text).toContain("/diagnostics");
    // Raised once already: a model failing all day says it a second time only
    // by being a different failure.
    expect(modelFailureNudge(records, new Set([nudge!.signature]), now))
        .toBeUndefined();
});

// A failure Vera never records (an interrupted review, an unreadable
// attachment) must not surface the previous model failure as if it were this
// one, so the newest record has to be recent enough to be the one on screen.
test("a stale ledger entry does not nudge on an unrelated failure", () => {
    const now = new Date("2026-08-19T15:00:00.000Z");
    expect(modelFailureNudge([record(), record()], new Set(), now))
        .toBeUndefined();
});

test("counting a signature ignores other signatures", () => {
    const records = [record(), record({ model: "other" })];
    expect(countModelFailureSignature(records, modelFailureSignature(record())))
        .toBe(1);
});

test("a corrupt line is skipped rather than losing the whole ledger", () => {
    const path = ledgerPath();
    try {
        const ledger = new ModelFailureLedger(path);
        ledger.record(record());
        Bun.write(path, `${JSON.stringify(record())}\nnot json\n`);
        expect(readModelFailures(path)).toHaveLength(1);
    } finally {
        rmSync(path, { force: true });
    }
});

test("a missing ledger reads as no failures", () => {
    expect(readModelFailures(join(tmpdir(), "vera-absent", "ledger.jsonl")))
        .toEqual([]);
});
