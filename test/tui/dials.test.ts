import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    adjustDialEffort,
    composeDialStrip,
    dialStripSelection,
    jumpDialStrip,
    moveDialStrip,
    openDialStrip,
    renderDialStrip,
    resolveFavoritePair,
    type DialPoolEntry,
} from "../../clients/tui/dials.ts";
import {
    loadTuiFavoritePairs,
    migrateTuiQuickslotsToFavoritePairs,
    saveTuiFavoritePairs,
} from "../../clients/tui/theme-preference.ts";

const POOL: readonly DialPoolEntry[] = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        poolName: "sol",
        levels: ["low", "medium", "high"],
    },
    {
        provider: "zai",
        model: "glm-5",
        poolName: "luna",
        levels: ["low", "high"],
    },
    { provider: "ollama", model: "qwen3:32b", levels: [] },
];

const SOL = { provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" };
const LUNA = { provider: "zai", model: "glm-5", effort: "high" };

test("a favourite resolves by name, then by id, and heals the name it finds", () => {
    expect(resolveFavoritePair({ name: "sol" }, POOL).pair)
        .toEqual({ provider: "openai-codex", model: "gpt-5.6-sol" });

    // The pool renamed sol to sunny while Vera was not running. The id still
    // finds it, and the favourite is rewritten rather than going stale.
    const renamed: readonly DialPoolEntry[] = [
        { ...POOL[0]!, poolName: "sunny" },
        ...POOL.slice(1),
    ];
    const healed = resolveFavoritePair(
        { name: "sol", provider: "openai-codex", modelId: "gpt-5.6-sol" },
        renamed,
    );
    expect(healed.pair?.model).toBe("gpt-5.6-sol");
    expect(healed.healedName).toBe("sunny");

    expect(resolveFavoritePair({ name: "gone" }, POOL).pair).toBeUndefined();
});

test("position one is always the committed pair, and nothing repeats", () => {
    const composition = composeDialStrip({
        current: SOL,
        favorites: [
            { name: "sol", effort: "low" },
            { name: "luna", effort: "high" },
        ],
        recents: [LUNA, SOL],
        pool: POOL,
    });
    expect(composition.slots.map((slot) => slot.label)).toEqual(["sol", "luna"]);
    expect(composition.slots[0]?.source).toBe("current");
    expect(composition.slots[0]?.pair).toEqual(SOL);
});

test("an unresolvable favourite is dimmed and unselectable, never dropped", () => {
    const composition = composeDialStrip({
        current: SOL,
        favorites: [{ name: "gone", effort: "high" }],
        recents: [],
        pool: POOL,
    });
    const stale = composition.slots[1]!;
    expect(stale.label).toBe("gone");
    expect(stale.pair).toBeUndefined();
    expect(stale.unavailable).toBe("not in your pool");

    const state = moveDialStrip(
        openDialStrip(composition, SOL),
        1,
    );
    expect(dialStripSelection(state)).toBeUndefined();
});

test("the strip caps at six and says how many it did not show", () => {
    const composition = composeDialStrip({
        current: SOL,
        favorites: [],
        recents: Array.from({ length: 9 }, (_, index) => ({
            provider: "zai",
            model: "glm-5",
            effort: `level-${index}`,
        })),
        pool: POOL,
    });
    expect(composition.slots).toHaveLength(6);
    expect(composition.overflow).toBe(4);
    expect(renderDialStrip(openDialStrip(composition, SOL), "hints")[0])
        .toContain("…");
});

test("moving sideways discards an uncommitted effort edit", () => {
    const composition = composeDialStrip({
        current: SOL,
        favorites: [{ name: "luna", effort: "high" }],
        recents: [],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL);
    state = adjustDialEffort(state, 1);
    expect(dialStripSelection(state)?.effort).toBe("medium");
    state = moveDialStrip(state, 1);
    state = moveDialStrip(state, -1);
    // Back where it started, and the edit did not follow.
    expect(dialStripSelection(state)?.effort).toBe("low");
});

test("effort moves by ordinal, does not wrap, and never touches the favourite", () => {
    const favorites = [{ name: "sol", effort: "low" }];
    const composition = composeDialStrip({
        current: SOL,
        favorites,
        recents: [],
        pool: POOL,
    });
    let state = openDialStrip(composition, SOL);
    state = adjustDialEffort(state, -1);
    expect(dialStripSelection(state)?.effort).toBe("low");
    state = adjustDialEffort(adjustDialEffort(state, 1), 1);
    expect(dialStripSelection(state)?.effort).toBe("high");
    state = adjustDialEffort(state, 1);
    expect(dialStripSelection(state)?.effort).toBe("high");
    expect(favorites).toEqual([{ name: "sol", effort: "low" }]);
});

test("a pair with no effort dial takes the arrows without complaint", () => {
    const bare = { provider: "ollama", model: "qwen3:32b" };
    const composition = composeDialStrip({
        current: bare,
        favorites: [],
        recents: [],
        pool: POOL,
    });
    const state = openDialStrip(composition, bare);
    expect(adjustDialEffort(state, 1)).toBe(state);
    expect(adjustDialEffort(state, -1)).toBe(state);
    expect(dialStripSelection(state)).toEqual(bare);
    expect(renderDialStrip(state, "hints")[1]).toContain("no effort dial");
});

test("a number jumps to a position, and out of range does nothing", () => {
    const composition = composeDialStrip({
        current: SOL,
        favorites: [{ name: "luna", effort: "high" }],
        recents: [],
        pool: POOL,
    });
    const state = openDialStrip(composition, SOL);
    expect(jumpDialStrip(state, 2).index).toBe(1);
    expect(jumpDialStrip(state, 9)).toBe(state);
    expect(jumpDialStrip(state, 0)).toBe(state);
});

async function preferencesPath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vera-dials-"));
    return join(root, "tui.json");
}

test("quickslots become favourites once, in both formats", async () => {
    const path = await preferencesPath();
    await Bun.write(
        path,
        JSON.stringify({
            theme: "default",
            extensions: {
                "vera.model-presets": {
                    slots: [
                        { name: "sol", reasoningEffort: "low" },
                        { name: "gone", reasoningEffort: "high" },
                        {
                            provider: "ollama",
                            model: "qwen3:32b",
                            reasoningEffort: "medium",
                        },
                        { nonsense: true },
                        null,
                    ],
                },
            },
        }),
    );

    const resolve = (name: string) =>
        name === "sol"
            ? { provider: "openai-codex", model: "gpt-5.6-sol" }
            : undefined;
    const first = migrateTuiQuickslotsToFavoritePairs(resolve, path);
    expect(first).toEqual({ migrated: 3, skipped: 1 });
    expect(loadTuiFavoritePairs(path)).toEqual([
        {
            name: "sol",
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            effort: "low",
        },
        // A name the pool no longer has stays name-only rather than being
        // dropped: it renders dimmed until the name resolves again.
        { name: "gone", effort: "high" },
        // Id-form is valid data, not something to skip.
        { provider: "ollama", modelId: "qwen3:32b", effort: "medium" },
    ]);

    // Idempotent: running again neither duplicates nor re-reads.
    saveTuiFavoritePairs([{ name: "sol", effort: "high" }], path);
    expect(migrateTuiQuickslotsToFavoritePairs(resolve, path))
        .toEqual({ migrated: 0, skipped: 0 });
    expect(loadTuiFavoritePairs(path)).toEqual([{ name: "sol", effort: "high" }]);
});

test("the legacy top-level block is read when no extension block exists", async () => {
    const path = await preferencesPath();
    await Bun.write(
        path,
        JSON.stringify({
            theme: "default",
            // The legacy top-level block only ever held the id form.
            model_presets: [{
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                reasoning_effort: "low",
            }],
        }),
    );
    expect(migrateTuiQuickslotsToFavoritePairs(() => undefined, path))
        .toEqual({ migrated: 1, skipped: 0 });
    expect(loadTuiFavoritePairs(path)).toEqual([
        { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "low" },
    ]);
});
