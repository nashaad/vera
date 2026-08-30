import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    availableModelsWithLevels,
    levelsForModel,
    pooledModels,
} from "../../src/model/catalog-view.ts";
import type { LearnedFacts } from "../../src/model/pool-file.ts";
import {
    addPoolModel,
    recordLearned,
} from "../../src/model/pool-file-store.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface Fixture {
    readonly userPath: string;
    readonly cacheDir: string;
}

test("available models carry the catalog levels and default level", () => {
    const options = fixture();

    expect(availableModelsWithLevels([
        suggested("test", "with-levels"),
        suggested("test", "no-levels"),
        suggested("test", "unknown-to-catalog"),
    ], options)).toEqual([
        {
            provider: "test",
            model: "with-levels",
            label: "With levels",
            description: "a model",
            imageSupport: true,
            levels: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", description: "slow" },
            ],
            defaultLevel: "high",
        },
        {
            provider: "test",
            model: "no-levels",
            label: "No levels",
            description: "a model",
            levels: [],
        },
        {
            provider: "test",
            model: "unknown-to-catalog",
            label: "Unknown to catalog",
            description: "a model",
            levels: [],
        },
    ]);
});

test("pool order is kept and levels the probe rejected drop away", () => {
    const options = fixture();
    admit(options, "test/no-levels", {});
    admit(options, "test/with-levels", {
        "efforts.high": { ok: true, seen: SEEN, wire: "high" },
        "efforts.low": { ok: false, seen: SEEN, error: "rejected" },
    });

    expect(pooledModels([
        suggested("test", "no-levels"),
        suggested("test", "with-levels"),
    ], options)).toEqual([
        {
            provider: "test",
            model: "with-levels",
            label: "With levels",
            available: true,
            verified: true,
            description: "catalog description",
            contextWindow: 200_000,
            imageSupport: true,
            levels: [{ id: "high", label: "High", description: "slow" }],
            defaultLevel: "high",
        },
        {
            provider: "test",
            model: "no-levels",
            label: "No levels",
            available: true,
            verified: true,
            levels: [],
        },
    ]);
});

test("a level nothing has an opinion on still comes from the catalog", () => {
    const options = fixture();
    admit(options, "test/with-levels", {
        "efforts.high": { ok: true, seen: SEEN, wire: "high" },
    });

    expect(pooledModels([suggested("test", "with-levels")], options)[0]?.levels)
        .toEqual([
            { id: "high", label: "High", description: "slow" },
            { id: "low", label: "Low" },
        ]);
});

test("a declared effort wins over the catalog's level list", () => {
    const options = fixture();
    addPoolModel("test/with-levels", { efforts: { low: null } }, {
        path: options.userPath,
    });
    recordLearned("test/with-levels", probed(), { path: options.userPath });

    expect(pooledModels([suggested("test", "with-levels")], options)[0]?.levels)
        .toEqual([{ id: "high", label: "High", description: "slow" }]);
});

test("an unprobed entry the provider lists is available but unverified", () => {
    const options = fixture();
    addPoolModel("test/with-levels", {}, { path: options.userPath });

    expect(pooledModels([
        suggested("test", "with-levels"),
    ], options)).toEqual([{
        provider: "test",
        model: "with-levels",
        label: "With levels",
        available: true,
        verified: false,
        description: "catalog description",
        contextWindow: 200_000,
        imageSupport: true,
        levels: [
            { id: "high", label: "High", description: "slow" },
            { id: "low", label: "Low" },
        ],
        defaultLevel: "high",
    }]);
});

test("a failed probe leaves the entry unverified", () => {
    const options = fixture();
    addPoolModel("test/no-levels", { added: true }, {
        path: options.userPath,
    });
    recordLearned("test/no-levels", {
        probe: { ok: false, seen: SEEN, error: "no answer" },
    }, { path: options.userPath });

    expect(pooledModels([
        suggested("test", "no-levels"),
    ], options)).toEqual([{
        provider: "test",
        model: "no-levels",
        label: "No levels",
        available: true,
        verified: false,
        levels: [],
    }]);
});

test("a pooled model that cannot run right now stays in the list, flagged", () => {
    const options = fixture();
    admit(options, "test/with-levels", {});
    addPoolModel("gone/forgotten", {}, { path: options.userPath });

    // The catalog still describes `with-levels`, but the host cannot run it,
    // so it is unavailable rather than absent, whatever the pool records.
    expect(pooledModels([], options)).toEqual([
        {
            provider: "gone",
            model: "forgotten",
            label: "forgotten",
            available: false,
            verified: false,
            levels: [],
        },
        {
            provider: "test",
            model: "with-levels",
            label: "with-levels",
            available: false,
            verified: true,
            levels: [],
        },
    ]);
});

test("a runnable model the catalog never heard of keeps the host's facts", () => {
    const options = fixture();
    admit(options, "test/unknown-to-catalog", {});

    expect(pooledModels([
        { ...suggested("test", "unknown-to-catalog"), contextWindow: 8_192 },
    ], options)).toEqual([{
        provider: "test",
        model: "unknown-to-catalog",
        label: "Unknown to catalog",
        available: true,
        verified: true,
        description: "a model",
        contextWindow: 8_192,
        levels: [],
    }]);
});

test("a denied model is not offered, whatever the pool says about it", () => {
    const options = fixture();
    admit(options, "test/with-levels", {});
    writeFileSync(options.userPath, JSON.stringify({
        defaults: { deny: ["test/*"] },
        models: { "test/with-levels": {} },
    }));

    expect(pooledModels([suggested("test", "with-levels")], options))
        .toEqual([]);
});

test("the project file contributes entries alongside the user file", () => {
    const options = fixture();
    admit(options, "test/no-levels", {});
    const projectPath = join(makeDirectory(), "pool.json");
    writeFileSync(projectPath, JSON.stringify({
        models: {
            "test/with-levels": { added: true, learned: probed() },
        },
    }));

    expect(pooledModels(
        [suggested("test", "no-levels"), suggested("test", "with-levels")],
        { ...options, projectPath },
    ).map((entry) => entry.model)).toEqual(["no-levels", "with-levels"]);
});

const SEEN = "2026-08-01T00:00:00.000Z";

function probed(): LearnedFacts {
    return {
        probe: { ok: true, seen: SEEN, checked: "user_key" },
        tools: { ok: true, seen: SEEN, checked: "user_key" },
    };
}

/** The two writes the host makes when a model passes admission. */
test("two ladder levels reaching one wire string list that level once", () => {
    const options = fixture();
    admit(options, "test/with-levels", {
        "efforts.high": { ok: true, seen: SEEN, wire: "high" },
        "efforts.xhigh": { ok: true, seen: SEEN, wire: "high" },
    });

    expect(pooledModels([suggested("test", "with-levels")], options)[0]?.levels)
        .toEqual([
            { id: "high", label: "High", description: "slow" },
            { id: "low", label: "Low" },
        ]);
});

function admit(
    options: Fixture,
    modelId: string,
    learned: LearnedFacts,
): void {
    addPoolModel(modelId, { added: true }, { path: options.userPath });
    recordLearned(modelId, { ...probed(), ...learned }, {
        path: options.userPath,
    });
}

function makeDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-catalog-view-"));
    directories.push(directory);
    return directory;
}

function fixture(withPricing = false): Fixture {
    const directory = makeDirectory();
    const cacheDir = join(directory, "cache");
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, "test.json"), JSON.stringify({
        schema_version: 2,
        provider: "test",
        fetched_at: "2026-07-27T00:00:00Z",
        models: [
            {
                id: "with-levels",
                label: "With levels",
                description: "catalog description",
                order: 1,
                context_window: 200_000,
                image_support: true,
                ...(withPricing
                    ? { pricing: { input: 0.2, output: 1.2 } }
                    : {}),
                default_level: "high",
                levels: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", description: "slow" },
                ],
            },
            { id: "no-levels", label: "No levels", order: 2 },
        ],
    }));
    return { userPath: join(directory, "pool.json"), cacheDir };
}

function suggested(provider: string, model: string): SuggestedModel {
    return {
        provider,
        model,
        label: model === "with-levels"
            ? "With levels"
            : model === "no-levels"
                ? "No levels"
                : "Unknown to catalog",
        description: "a model",
    };
}

// The curation names models, and the catalog carries the flag. Both projections
// pass it through, so the picker filters one set of rows rather than holding a
// second list of its own.
test("a recommended model carries the flag and its level to both projections", () => {
    const options = {
        ...fixture(),
        recommended: [
            { provider: "test", model: "with-levels", reasoning_effort: "high" },
        ],
    };

    const available = availableModelsWithLevels([
        suggested("test", "with-levels"),
        suggested("test", "no-levels"),
    ], options);
    expect(available[0]?.recommended).toBe(true);
    expect(available[0]?.recommendedLevel).toBe("high");
    expect(available[1]?.recommended).toBeUndefined();

    addPoolModel("test/with-levels", {}, { path: options.userPath });
    const pooled = pooledModels([suggested("test", "with-levels")], options);
    expect(pooled[0]?.recommended).toBe(true);
    expect(pooled[0]?.recommendedLevel).toBe("high");
});

test("an entry holding only learned facts is not in the pool", () => {
    const options = fixture();
    recordLearned("test/no-levels", probed(), { path: options.userPath });

    expect(pooledModels([suggested("test", "no-levels")], options))
        .toEqual([]);

    addPoolModel("test/no-levels", { added: true }, {
        path: options.userPath,
    });

    // Pooling it later keeps what was already learned, so the entry arrives
    // verified rather than starting over.
    expect(pooledModels([suggested("test", "no-levels")], options))
        .toMatchObject([{ model: "no-levels", verified: true }]);
});

test("a named entry carries its name to the clients", () => {
    const options = fixture();
    writeFileSync(options.userPath, JSON.stringify({
        models: {
            "test/with-levels": { name: "frosty" },
            "test/no-levels": {},
        },
    }));

    const pooled = pooledModels([
        suggested("test", "with-levels"),
        suggested("test", "no-levels"),
    ], options);

    expect(pooled.find((entry) => entry.model === "with-levels")?.poolName)
        .toBe("frosty");
    expect(pooled.find((entry) => entry.model === "no-levels")?.poolName)
        .toBeUndefined();
});

test("a pool row reports image support from whichever source knows", () => {
    const options = fixture();
    // The catalog says yes and nothing contradicts it.
    admit(options, "test/with-levels", {});
    // The probe answered for a model the catalog says nothing about.
    admit(options, "test/no-levels", {
        images: { ok: false, seen: SEEN, error: "no image input" },
    });

    const rows = pooledModels([
        suggested("test", "with-levels"),
        suggested("test", "no-levels"),
    ], options);
    const support = (model: string): boolean | undefined =>
        rows.find((row) => row.model === model)?.imageSupport;

    expect(support("with-levels")).toBe(true);
    expect(support("no-levels")).toBe(false);
});

const HIGH_LOW = [{ id: "high", label: "High" }, { id: "low", label: "Low" }];

const CATALOG_ROW = {
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    label: "Kimi K3",
    description: "",
    levels: HIGH_LOW,
};

test("a model the pool never admitted takes its levels from the catalog", () => {
    expect(
        levelsForModel("openrouter", "moonshotai/kimi-k3", [], [CATALOG_ROW])
            .levels,
    ).toEqual(HIGH_LOW);
});

test("a ready pool entry answers, empty level list included", () => {
    const pooled = [{
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        label: "Kimi K3",
        available: true,
        verified: true,
        levels: [],
    }];
    expect(
        levelsForModel("openrouter", "moonshotai/kimi-k3", pooled, [CATALOG_ROW])
            .levels,
    ).toEqual([]);
});

test("an unavailable pool entry steps aside for the catalog", () => {
    const pooled = [{
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        label: "Kimi K3",
        available: false,
        verified: false,
        levels: [],
    }];
    expect(
        levelsForModel("openrouter", "moonshotai/kimi-k3", pooled, [CATALOG_ROW])
            .levels,
    ).toEqual(HIGH_LOW);
});

test("nothing anywhere is an empty list, not a guess", () => {
    expect(levelsForModel("openrouter", "nobody/knows-me", [], []).levels)
        .toEqual([]);
});

// The catalog answers for a model the pool never admitted, and it still knows
// which levels this key was refused: the provider answered 400 for one of them.
test("a level the provider refused is not offered by the catalog projection", () => {
    const options = fixture();
    recordLearned("test/with-levels", {
        "efforts.high": {
            ok: false,
            seen: SEEN,
            error: "Invalid value: 'high'",
        },
    }, { path: options.userPath });

    const available = availableModelsWithLevels(
        [suggested("test", "with-levels")],
        options,
    );
    expect(available[0]?.levels).toEqual([{ id: "low", label: "Low" }]);

    // The catalog's default level pointed at the refused rung, so it goes too
    // rather than naming a level the picker cannot show.
    expect(available[0]?.defaultLevel).toBeUndefined();
});

// A level the user wrote into the entry by hand outranks a past refusal, which
// is the precedence `resolveEffort` already applies.
test("a declared level survives a recorded refusal", () => {
    const options = fixture();
    addPoolModel("test/with-levels", { efforts: { high: "high" } }, {
        path: options.userPath,
    });
    recordLearned("test/with-levels", {
        "efforts.high": { ok: false, seen: SEEN, error: "refused once" },
    }, { path: options.userPath });

    expect(
        availableModelsWithLevels([suggested("test", "with-levels")], options)
            .at(0)?.levels,
    ).toEqual([
        { id: "low", label: "Low" },
        { id: "high", label: "High", description: "slow" },
    ]);
});

test("known pricing reaches both client-facing model projections", () => {
    const options = fixture(true);
    const available = availableModelsWithLevels(
        [suggested("test", "with-levels")],
        options,
    );
    expect(available[0]?.pricing).toEqual({ input: 0.2, output: 1.2 });
    expect(available[0]?.imageSupport).toBe(true);

    addPoolModel("test/with-levels", {}, { path: options.userPath });
    const pooled = pooledModels([suggested("test", "with-levels")], options);
    expect(pooled[0]?.pricing).toEqual({ input: 0.2, output: 1.2 });
});
