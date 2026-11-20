import { expect, test } from "bun:test";

import { startingVeraConfig, type VeraConfig } from "../../src/config.ts";
import {
    MAX_MISSING_SCANS,
    applyCatalogScan,
    trackedModels,
    type CatalogListingFacts,
    type ModelAvailabilityRecord,
    type ModelDropNotice,
    type TrackedModel,
} from "../../src/model/model-availability.ts";
import type { PoolFile } from "../../src/model/pool-file.ts";

const AT = "2026-11-20T15:00:00.000Z";
const NEXT = "2026-11-21T15:00:00.000Z";
const THIRD = "2026-11-22T15:00:00.000Z";

function config(overrides: Partial<VeraConfig> = {}): VeraConfig {
    return { ...startingVeraConfig(), ...overrides };
}

function pool(models: PoolFile["models"], allow?: readonly string[]): PoolFile {
    return { defaults: allow === undefined ? {} : { allow }, models };
}

function favorite(provider: string, model: string): TrackedModel {
    return { provider, model, roles: ["favorite"] };
}

function scan(
    previous: ModelAvailabilityRecord | undefined,
    tracked: readonly TrackedModel[],
    listings: readonly CatalogListingFacts[],
    at = AT,
    deliver: (notice: ModelDropNotice) => boolean = () => true,
): { record: ModelAvailabilityRecord; dropped: number; notices: ModelDropNotice[] } {
    const notices: ModelDropNotice[] = [];
    const result = applyCatalogScan(previous, tracked, listings, at, (notice) => {
        notices.push(notice);
        return deliver(notice);
    });
    return { record: result.next, dropped: result.dropped, notices };
}

function listing(provider: string, listed: readonly string[]): CatalogListingFacts {
    return { provider, listed };
}

test("tracked models cover curated favorites, the default, and assignments", () => {
    const tracked = trackedModels(config({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        models: [
            { name: "fast", provider: "openrouter", model: "openai/gpt-5-mini" },
            { name: "grok", provider: "openrouter", model: "x-ai/grok-4" },
        ],
        model_routes: { cheap: ["grok"] },
        model_assignments: {
            snappy: { model_route: "cheap" },
            reviewer: { models: [{ name: "r", provider: "openrouter", model: "google/gemini-3-pro" }] },
        },
    }), pool({
        "openrouter/anthropic/claude-sonnet-4.5": { added: true },
        "openrouter/openai/gpt-5-mini": { added: true },
        "openrouter/legacy-model": { added: false },
        "openrouter/not-added": { added: false },
    }));

    expect(tracked.models).toEqual([
        { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", roles: ["favorite", "default"] },
        { provider: "openrouter", model: "google/gemini-3-pro", roles: ["assignment:reviewer"] },
        { provider: "openrouter", model: "openai/gpt-5-mini", roles: ["favorite"] },
        { provider: "openrouter", model: "x-ai/grok-4", roles: ["assignment:snappy"] },
    ]);
    expect(tracked.droppedFavorites).toBe(0);
});

test("a pool deny rule keeps a model out of the tracked set", () => {
    const tracked = trackedModels(
        config({ provider: "openrouter", model: "kept/model" }),
        pool({ "openrouter/blocked/model": { added: true } }, ["!openrouter/blocked/*"]),
    );
    expect(tracked.models).toEqual([
        { provider: "openrouter", model: "kept/model", roles: ["default"] },
    ]);
});

test("the tracked cap keeps pinned models and drops favorites in pool order", () => {
    const tracked = trackedModels(
        config({ provider: "openrouter", model: "default/model" }),
        pool({
            "openrouter/one": { added: true },
            "openrouter/two": { added: true },
            "openrouter/three": { added: true },
        }),
        2,
    );
    expect(tracked.models).toEqual([
        { provider: "openrouter", model: "default/model", roles: ["default"] },
        { provider: "openrouter", model: "one", roles: ["favorite"] },
    ]);
    expect(tracked.droppedFavorites).toBe(2);
});

test("a listed model records its last sighting and no miss", () => {
    const { record, notices } = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]);
    expect(record).toEqual({
        schema_version: 1,
        last_scan_at: AT,
        models: [{
            provider: "openrouter",
            model: "a/b",
            roles: ["favorite"],
            last_seen_at: AT,
            missing_scans: 0,
        }],
    });
    expect(notices).toEqual([]);
});

test("one authoritative miss records the first missing day without a drop", () => {
    const seen = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const { record, notices, dropped } = scan(seen, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT);
    expect(record.models[0]).toEqual({
        provider: "openrouter",
        model: "a/b",
        roles: ["favorite"],
        last_seen_at: AT,
        first_missing_at: NEXT,
        missing_scans: 1,
    });
    expect(notices).toEqual([]);
    expect(dropped).toBe(0);
});

test("a second consecutive miss drops and delivers once", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT).record;
    const { record, notices, dropped } = scan(
        second,
        [{ provider: "openrouter", model: "a/b", roles: ["favorite", "default"] }],
        [listing("openrouter", ["other"])],
        THIRD,
    );
    expect(record.models[0]).toEqual({
        provider: "openrouter",
        model: "a/b",
        roles: ["favorite", "default"],
        last_seen_at: AT,
        first_missing_at: NEXT,
        missing_scans: 2,
        dropped_at: THIRD,
        notified_at: THIRD,
    });
    expect(notices).toEqual([{
        provider: "openrouter",
        model: "a/b",
        roles: ["favorite", "default"],
        last_seen_at: AT,
        first_missing_at: NEXT,
        missing_scans: 2,
    }]);
    expect(dropped).toBe(1);
});

test("a third miss does not deliver again", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT).record;
    const third = scan(second, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], THIRD).record;
    const fourth = scan(third, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], "2026-11-23T15:00:00.000Z");
    expect(fourth.record.models[0]!.missing_scans).toBe(3);
    expect(fourth.record.models[0]!.dropped_at).toBe(THIRD);
    expect(fourth.record.models[0]!.notified_at).toBe(THIRD);
    expect(fourth.notices).toEqual([]);
});

test("a model that comes back clears its drop history", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT).record;
    const dropped = scan(second, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], THIRD).record;
    const back = scan(dropped, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["a/b"])], "2026-11-24T15:00:00.000Z").record;
    expect(back.models[0]).toEqual({
        provider: "openrouter",
        model: "a/b",
        roles: ["default"],
        last_seen_at: "2026-11-24T15:00:00.000Z",
        missing_scans: 0,
    });
});

test("a failed or empty provider answer neither advances nor resets", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const missed = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT).record;
    for (const listings of [
        [{ provider: "openrouter" }],
        [listing("openrouter", [])],
        [],
    ] satisfies readonly (readonly CatalogListingFacts[])[]) {
        const { record, notices } = scan(missed, [favorite("openrouter", "a/b")], listings, THIRD);
        expect(record.models[0]).toEqual(missed.models[0]!);
        expect(notices).toEqual([]);
    }
});

test("an uncovered provider keeps the entry without counting a miss", () => {
    const first = scan(undefined, [favorite("anthropic", "claude-sonnet-4.5")], [listing("anthropic", ["claude-sonnet-4.5"])]).record;
    const { record } = scan(first, [favorite("anthropic", "claude-sonnet-4.5")], [], NEXT);
    expect(record.models[0]).toEqual(first.models[0]!);
});

test("a favorite-only drop is recorded but not delivered", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT).record;
    const { record, notices } = scan(second, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], THIRD);
    expect(record.models[0]!.dropped_at).toBe(THIRD);
    expect(record.models[0]!.notified_at).toBeUndefined();
    expect(notices).toEqual([]);
});

test("an assignment drop delivers once even across several roles", () => {
    const roles = ["favorite", "default", "assignment:eco"] as const;
    const first = scan(undefined, [{ provider: "openrouter", model: "a/b", roles: [...roles] }], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [{ provider: "openrouter", model: "a/b", roles: [...roles] }], [listing("openrouter", ["other"])], NEXT).record;
    const { notices } = scan(second, [{ provider: "openrouter", model: "a/b", roles: [...roles] }], [listing("openrouter", ["other"])], THIRD);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.roles).toEqual(["favorite", "default", "assignment:eco"]);
});

test("a model pinned after it dropped delivers on the next authoritative scan", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], NEXT).record;
    const dropped = scan(second, [favorite("openrouter", "a/b")], [listing("openrouter", ["other"])], THIRD).record;
    const { record, notices } = scan(
        dropped,
        [{ provider: "openrouter", model: "a/b", roles: ["favorite", "assignment:extra"] }],
        [listing("openrouter", ["other"])],
        "2026-11-23T15:00:00.000Z",
    );
    expect(notices).toHaveLength(1);
    expect(record.models[0]!.notified_at).toBe("2026-11-23T15:00:00.000Z");
});

test("a failed notice write leaves notified_at unset for the next scan", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b"])]).record;
    const second = scan(first, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], NEXT).record;
    const failed = scan(second, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], THIRD, () => false);
    expect(failed.record.models[0]!.notified_at).toBeUndefined();
    expect(failed.dropped).toBe(0);
    const retried = scan(failed.record, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], "2026-11-23T15:00:00.000Z");
    expect(retried.record.models[0]!.notified_at).toBe("2026-11-23T15:00:00.000Z");
    expect(retried.notices).toHaveLength(1);
});

test("an untracked model leaves the record", () => {
    const first = scan(undefined, [favorite("openrouter", "a/b"), favorite("openrouter", "c/d")], [listing("openrouter", ["a/b", "c/d"])]).record;
    const { record } = scan(first, [favorite("openrouter", "a/b")], [listing("openrouter", ["a/b", "c/d"])], NEXT);
    expect(record.models.map((entry) => entry.model)).toEqual(["a/b"]);
});

test("a scan with nothing tracked still moves last_scan_at", () => {
    const { record } = scan(undefined, [], []);
    expect(record).toEqual({ schema_version: 1, last_scan_at: AT, models: [] });
});

test("miss counts saturate at the record limit", () => {
    const previous: ModelAvailabilityRecord = {
        schema_version: 1,
        last_scan_at: AT,
        models: [{
            provider: "openrouter",
            model: "a/b",
            roles: ["default"],
            first_missing_at: AT,
            missing_scans: MAX_MISSING_SCANS,
            dropped_at: AT,
            notified_at: AT,
        }],
    };
    const { record } = scan(previous, [{ provider: "openrouter", model: "a/b", roles: ["default"] }], [listing("openrouter", ["other"])], NEXT);
    expect(record.models[0]!.missing_scans).toBe(MAX_MISSING_SCANS);
});

test("provider and model match as an exact pair, slashes included", () => {
    const tracked = [{ provider: "openrouter", model: "anthropic/claude-sonnet-4.5", roles: ["default"] }] as const;
    const seen = scan(undefined, tracked, [listing("openrouter", ["anthropic/claude-sonnet-4.5"])]).record;
    expect(seen.models[0]!.last_seen_at).toBe(AT);
    const missed = scan(seen, tracked, [listing("openrouter", ["anthropic/claude-sonnet-4"])], NEXT);
    expect(missed.record.models[0]!.missing_scans).toBe(1);
});
