import { expect, test } from "bun:test";

import {
    DEFAULT_MAX_AGE_MONTHS,
    reduceModels,
} from "../../src/model/catalog-reduction.ts";

const NOW = 1_760_000_000;
const MONTH = 30.44 * 24 * 60 * 60;

test("a batch row is hidden because it names a submission mode", () => {
    const hidden = reduceModels([
        { id: "anthropic/claude-opus-5", created: NOW },
        { id: "anthropic/claude-opus-5:batch", created: NOW },
    ], { now: NOW });
    expect(hidden.get("anthropic/claude-opus-5:batch")).toBe("batch");
    expect(hidden.has("anthropic/claude-opus-5")).toBe(false);
});

test("an alias row is hidden only while its target is listed", () => {
    const withTarget = reduceModels([
        { id: "anthropic/claude-opus-4.8", created: NOW },
        { id: "~anthropic/claude-opus-latest", created: NOW },
    ], { now: NOW });
    expect(withTarget.get("~anthropic/claude-opus-latest")).toBe("alias");

    const withoutTarget = reduceModels([
        { id: "~anthropic/claude-opus-latest", created: NOW },
    ], { now: NOW });
    expect(withoutTarget.has("~anthropic/claude-opus-latest")).toBe(false);
});

test("a model older than the cutoff is hidden and a recent one is not", () => {
    const hidden = reduceModels([
        { id: "openai/gpt-3.5-turbo", created: NOW - (DEFAULT_MAX_AGE_MONTHS + 2) * MONTH },
        { id: "openai/gpt-5.6-sol", created: NOW - MONTH },
    ], { now: NOW });
    expect(hidden.get("openai/gpt-3.5-turbo")).toBe("old");
    expect(hidden.has("openai/gpt-5.6-sol")).toBe(false);
});

test("a model with no date is kept, because absence is not evidence of age", () => {
    const hidden = reduceModels([{ id: "local/undated" }], { now: NOW });
    expect(hidden.size).toBe(0);
});

test("a kept id survives every rule", () => {
    const hidden = reduceModels([
        { id: "anthropic/claude-opus-5:batch", created: NOW },
        { id: "openai/gpt-3.5-turbo", created: NOW - 60 * MONTH },
    ], {
        now: NOW,
        keep: new Set(["anthropic/claude-opus-5:batch", "openai/gpt-3.5-turbo"]),
    });
    expect(hidden.size).toBe(0);
});

test("the cutoff is configurable per call", () => {
    const models = [{ id: "openai/gpt-5.5", created: NOW - 3 * MONTH }];
    expect(reduceModels(models, { now: NOW, maxAgeMonths: 6 }).size).toBe(0);
    expect(reduceModels(models, { now: NOW, maxAgeMonths: 1 }).get("openai/gpt-5.5"))
        .toBe("old");
});

test("a cutoff of zero months turns the age rule off entirely", () => {
    const hidden = reduceModels([
        { id: "openai/gpt-3.5-turbo", created: NOW - 120 * MONTH },
    ], { now: NOW, maxAgeMonths: 0 });
    expect(hidden.size).toBe(0);
});
