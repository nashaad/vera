import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
    ALL_MODELS_GROUP,
    FAVORITES_GROUP,
    RECENT_GROUP,
    RECOMMENDED_GROUP,
    createTuiModelSwitcherView,
    handleTuiModelSwitcherKey,
    modelSwitcherKey,
    onSwitcherBrowseRow,
    refreshedTuiModelSwitcher,
    startTuiModelSwitcher,
    switcherCounterText,
    switcherEmptyMessage,
    searchedTuiModelSwitcher,
    switcherFooterText,
    switcherStop,
    type TuiModelSwitcherRow,
} from "../../clients/tui/model-switcher.ts";

const rows: readonly TuiModelSwitcherRow[] = [
    { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", favorite: true, effort: "high" },
    { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { provider: "openai", model: "gpt-5.6", label: "GPT-5.6", favorite: true },
    { provider: "openai", model: "gpt-5.6-mini", label: "GPT-5.6 mini" },
    { provider: "ollama", model: "qwen3:32b", label: "qwen3:32b", unavailable: true },
];

const started = (context = {}) => startTuiModelSwitcher(rows, context);

describe("model switcher ordering", () => {
    test("favorites come first, then recents, then every provider", () => {
        const state = started({ recents: ["ollama/qwen3:32b", "anthropic/claude-sonnet-5"] });
        expect(state.rows.map((row) => row.label)).toEqual([
            "Claude Opus 5",
            "GPT-5.6",
            "qwen3:32b",
            "Claude Sonnet 5",
            "GPT-5.6 mini",
        ]);
        expect(state.groups).toEqual([
            FAVORITES_GROUP,
            FAVORITES_GROUP,
            RECENT_GROUP,
            RECENT_GROUP,
            "openai",
        ]);
    });

    test("nothing is listed twice when a recent is also a favorite", () => {
        const state = started({ recents: ["openai/gpt-5.6"] });
        const keys = state.rows.map(modelSwitcherKey);
        expect(new Set(keys).size).toBe(keys.length);
        expect(state.rows.length).toBe(rows.length);
    });

    test("the catalog is not gated: every connected model is listed", () => {
        expect(started().rows.length).toBe(rows.length);
    });

    test("the cursor opens on the current model", () => {
        const state = started({ current: "openai/gpt-5.6-mini" });
        expect(state.rows[state.selectedIndex]?.label).toBe("GPT-5.6 mini");
    });
});

describe("model switcher search", () => {
    const typed = (query: string) => searchedTuiModelSwitcher(started(), query);

    test("typing reaches a model from any provider", () => {
        expect(typed("qwen").rows.map((row) => row.label)).toEqual(["qwen3:32b"]);
    });

    test("typing collapses the groups into one list", () => {
        const searching = typed("gpt");
        expect(searching.rows.map((row) => row.label)).toEqual(["GPT-5.6", "GPT-5.6 mini"]);
        expect(new Set(searching.groups)).toEqual(new Set([""]));
    });

    test("a match on the model id reaches a model the label does not name", () => {
        expect(typed("sonnet").rows.map((row) => row.label)).toEqual(["Claude Sonnet 5"]);
    });

    test("clearing the search restores the groups", () => {
        expect(typed("gpt")).not.toEqual(started());
        expect(searchedTuiModelSwitcher(typed("gpt"), "").groups).toEqual(started().groups);
    });

    test("a search that matches nothing says so rather than offering providers", () => {
        const empty = typed("zzz");
        expect(empty.rows).toEqual([]);
        expect(switcherEmptyMessage(empty)).toContain("No models match that search.");
    });

    test("an empty catalog sends the user to providers", () => {
        const empty = startTuiModelSwitcher([]);
        expect(switcherEmptyMessage(empty)).toContain("connects a provider");
        expect(handleTuiModelSwitcherKey(empty, { name: "return" }).providers).toBe(true);
    });
});

describe("model switcher keys", () => {
    test("enter picks the highlighted model", () => {
        const state = started();
        const moved = handleTuiModelSwitcherKey(state, { name: "down" }).state!;
        expect(handleTuiModelSwitcherKey(moved, { name: "return" }).selection?.label)
            .toBe("GPT-5.6");
    });

    test("ctrl+f asks for a favorite toggle without leaving the dialog", () => {
        const transition = handleTuiModelSwitcherKey(started(), { name: "f", ctrl: true });
        expect(transition.favorite?.label).toBe("Claude Opus 5");
        expect(transition.state).toBeDefined();
        expect(transition.selection).toBeUndefined();
    });

    test("escape closes", () => {
        const transition = handleTuiModelSwitcherKey(started(), { name: "escape" });
        expect(transition.handled).toBe(true);
        expect(transition.state).toBeUndefined();
    });

    test("the cursor cannot leave the list", () => {
        const state = started();
        expect(handleTuiModelSwitcherKey(state, { name: "up" }).state?.selectedIndex).toBe(0);
        const last = handleTuiModelSwitcherKey(state, { name: "end" }).state!;
        // One past the last model is the browse row, and nothing is past that.
        expect(last.selectedIndex).toBe(rows.length);
        expect(handleTuiModelSwitcherKey(last, { name: "down" }).state?.selectedIndex)
            .toBe(rows.length);
    });

    test("ctrl+u and ctrl+d page the list", () => {
        const many = Array.from({ length: 30 }, (_, index) => ({
            provider: "openai",
            model: `m${index}`,
            label: `M${index}`,
        }));
        const state = startTuiModelSwitcher(many);
        const down = handleTuiModelSwitcherKey(state, { name: "d", ctrl: true }).state!;
        expect(down.selectedIndex).toBe(10);
        expect(handleTuiModelSwitcherKey(down, { name: "u", ctrl: true }).state?.selectedIndex)
            .toBe(0);
    });

    test("ctrl+b leaves for the browse page", () => {
        const transition = handleTuiModelSwitcherKey(started(), { name: "b", ctrl: true });
        expect(transition.browse).toBe(true);
        expect(transition.handled).toBe(true);
        expect(transition.state).toBeUndefined();
    });

    test("the footer names paging once the keys belong to the list", () => {
        const list = handleTuiModelSwitcherKey(started(), { name: "down" }).state!;
        expect(switcherFooterText(list)).toContain("^u^d page");
        expect(switcherFooterText(list)).toContain("←→ sections");
        expect(switcherFooterText(started())).toContain("↓ list");
    });

    test("tab walks search, the list and the browse row", () => {
        const search = started();
        expect(switcherStop(search)).toBe("search");
        const list = handleTuiModelSwitcherKey(search, { name: "tab" }).state!;
        expect(switcherStop(list)).toBe("list");
        const browse = handleTuiModelSwitcherKey(list, { name: "tab" }).state!;
        expect(switcherStop(browse)).toBe("browse");
        expect(switcherStop(handleTuiModelSwitcherKey(browse, { name: "tab" }).state!))
            .toBe("search");
        expect(switcherStop(handleTuiModelSwitcherKey(list, { name: "tab", shift: true }).state!))
            .toBe("search");
    });

    test("left returns to search and right reaches the browse row", () => {
        const list = handleTuiModelSwitcherKey(started(), { name: "down" }).state!;
        expect(switcherStop(handleTuiModelSwitcherKey(list, { name: "left" }).state!))
            .toBe("search");
        const browse = handleTuiModelSwitcherKey(list, { name: "right" }).state!;
        expect(onSwitcherBrowseRow(browse)).toBe(true);
        // Coming back off the browse row lands on the last model, not past it.
        const back = handleTuiModelSwitcherKey(browse, { name: "left" }).state!;
        expect(back.selectedIndex).toBe(back.rows.length - 1);
    });

    test("a horizontal arrow in search stays in search", () => {
        for (const name of ["left", "right"]) {
            const transition = handleTuiModelSwitcherKey(started(), { name });
            expect(transition.handled).toBe(true);
            expect(switcherStop(transition.state!)).toBe("search");
        }
    });

    test("typing returns the keys to search", () => {
        const list = handleTuiModelSwitcherKey(started(), { name: "down" }).state!;
        expect(switcherStop(searchedTuiModelSwitcher(list, "gpt"))).toBe("search");
    });

    test("the counter does not count the browse row as a model", () => {
        const last = handleTuiModelSwitcherKey(started(), { name: "end" }).state!;
        expect(switcherCounterText(last)).toBe(`${rows.length}/${rows.length}`);
    });

    test("the cursor reaches the browse row one past the last model", () => {
        const last = handleTuiModelSwitcherKey(started(), { name: "end" }).state!;
        expect(onSwitcherBrowseRow(last)).toBe(true);
        expect(last.rows[last.selectedIndex]).toBeUndefined();
        expect(handleTuiModelSwitcherKey(last, { name: "return" }).browse).toBe(true);
        expect(handleTuiModelSwitcherKey(last, { name: "down" }).state?.selectedIndex)
            .toBe(last.selectedIndex);
    });

    test("no browse control is bound: scope and sort keys fall through", () => {
        for (const key of [{ name: "g", ctrl: true }, { name: "s", ctrl: true }]) {
            expect(handleTuiModelSwitcherKey(started(), key).handled).toBe(false);
        }
    });
});

describe("model switcher seeded favorites", () => {
    const seeded: readonly TuiModelSwitcherRow[] = [
        { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", seeded: true },
        { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { provider: "openai", model: "gpt-5.6", label: "GPT-5.6", seeded: true },
    ];

    test("a seeded row is listed under recommended, not favorites", () => {
        const state = startTuiModelSwitcher(seeded);
        expect(state.rows.map((row) => row.label)).toEqual([
            "Claude Opus 5",
            "GPT-5.6",
            "Claude Sonnet 5",
        ]);
        expect(state.groups).toEqual([
            RECOMMENDED_GROUP,
            RECOMMENDED_GROUP,
            "anthropic",
        ]);
    });

    test("a chosen favorite outranks a seeded row and keeps its own heading", () => {
        const state = startTuiModelSwitcher([
            ...seeded,
            { provider: "openai", model: "gpt-5.6-mini", label: "GPT-5.6 mini", favorite: true },
        ]);
        expect(state.groups.slice(0, 3)).toEqual([
            FAVORITES_GROUP,
            RECOMMENDED_GROUP,
            RECOMMENDED_GROUP,
        ]);
        expect(state.rows[0]?.label).toBe("GPT-5.6 mini");
    });

    test("ctrl+f on a seeded row offers to add it, not to remove it", () => {
        const state = startTuiModelSwitcher(seeded);
        expect(switcherFooterText(state)).toContain("^f favorite");
        expect(handleTuiModelSwitcherKey(state, { name: "f", ctrl: true }).favorite?.label)
            .toBe("Claude Opus 5");
    });
});

describe("model switcher provider headings", () => {
    const openrouter: readonly TuiModelSwitcherRow[] = [
        { provider: "openrouter", model: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", seeded: true },
        { provider: "openrouter", model: "z-ai/glm-5.2", label: "GLM-5.2" },
        { provider: "openrouter", model: "moonshotai/kimi-k3", label: "Kimi K3" },
    ];

    test("one connected provider is not named, but its rows keep a heading", () => {
        const state = startTuiModelSwitcher(openrouter);
        expect(state.groups).toEqual([
            RECOMMENDED_GROUP,
            ALL_MODELS_GROUP,
            ALL_MODELS_GROUP,
        ]);
    });

    test("two connected providers each get a heading", () => {
        const state = startTuiModelSwitcher([
            ...openrouter,
            { provider: "openai-codex", model: "gpt-5.6-sol", label: "GPT-5.6 Sol (Codex)" },
        ]);
        expect(state.groups).toEqual([
            RECOMMENDED_GROUP,
            "openrouter",
            "openrouter",
            "openai-codex",
        ]);
    });

    test("ungrouped rows stay in the model column under a heading", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            view.update(startTuiModelSwitcher([
                { provider: "openrouter", model: "z-ai/glm-5.2", label: "GLM-5.2", favorite: true },
                ...openrouter.slice(1),
            ]));
            await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n");
            const at = (label: string): number =>
                lines.findIndex((line) => line.includes(label));
            const column = (label: string): number => lines[at(label)]!.indexOf(label);
            expect(column("GLM-5.2")).toBe(column("Kimi K3"));
            // The favorite block has to end somewhere visible.
            expect(at("all models")).toBeGreaterThan(at("GLM-5.2"));
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a search names the provider only when more than one is connected", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            view.update(searchedTuiModelSwitcher(startTuiModelSwitcher(openrouter), "glm"));
            await setup.renderOnce();
            expect(setup.captureCharFrame()).not.toContain("openrouter");
            view.update(searchedTuiModelSwitcher(
                startTuiModelSwitcher([
                    ...openrouter,
                    { provider: "openai-codex", model: "gpt-5.6-sol", label: "GPT-5.6 Sol (Codex)" },
                ]),
                "glm",
            ));
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("openrouter");
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("model switcher favoriting", () => {
    test("a toggled row keeps the cursor after the list reorders", () => {
        const atBrowse = handleTuiModelSwitcherKey(started(), { name: "end" }).state!;
        const state = handleTuiModelSwitcherKey(
            handleTuiModelSwitcherKey(atBrowse, { name: "up" }).state!,
            { name: "up" },
        ).state!;
        const held = state.rows[state.selectedIndex]!;
        expect(held.label).toBe("GPT-5.6 mini");
        const promoted = rows.map((row) =>
            modelSwitcherKey(row) === modelSwitcherKey(held) ? { ...row, favorite: true } : row
        );
        const next = refreshedTuiModelSwitcher(state, promoted, state.recents, "Added to favorites");
        expect(next.rows[next.selectedIndex]?.label).toBe("GPT-5.6 mini");
        expect(next.groups[next.selectedIndex]).toBe(FAVORITES_GROUP);
        expect(next.notice).toBe("Added to favorites");
    });

    test("the pending notice stands until the snapshot carries the change", () => {
        const state = started({ current: "openai/gpt-5.6-mini" });
        const held = state.rows[state.selectedIndex]!;
        const waiting = refreshedTuiModelSwitcher(
            state,
            state.allRows,
            state.recents,
            "Adding it to favorites…",
            { key: modelSwitcherKey(held), favorite: true },
        );
        expect(waiting.notice).toBe("Adding it to favorites…");
        // A snapshot that does not carry the change yet leaves the notice up.
        expect(refreshedTuiModelSwitcher(waiting, state.allRows, state.recents).notice)
            .toBe("Adding it to favorites…");
        const kept = state.allRows.map((row) =>
            modelSwitcherKey(row) === modelSwitcherKey(held)
                ? { ...row, favorite: true }
                : row
        );
        const settled = refreshedTuiModelSwitcher(waiting, kept, state.recents);
        expect(settled.notice).toBeUndefined();
        expect(settled.pending).toBeUndefined();
    });

    test("a late recents reply fills the recents group without moving the cursor", () => {
        const state = started();
        const held = state.rows[state.selectedIndex]!;
        const next = refreshedTuiModelSwitcher(state, state.allRows, ["ollama/qwen3:32b"]);
        expect(next.recents).toEqual(["ollama/qwen3:32b"]);
        expect(next.groups).toContain(RECENT_GROUP);
        expect(next.rows[next.selectedIndex]?.label).toBe(held.label);
    });

    test("the footer names the action the highlighted row would take", () => {
        const state = started();
        expect(switcherFooterText(state)).toContain("^f unfavorite");
        const last = handleTuiModelSwitcherKey(
            handleTuiModelSwitcherKey(state, { name: "end" }).state!,
            { name: "up" },
        ).state!;
        expect(switcherFooterText(last)).toContain("^f favorite");
    });
});

describe("model switcher rendering", () => {
    test("the dialog shows groups, the current row and no browse controls", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            view.update(started({
                current: "anthropic/claude-opus-5",
                recents: ["ollama/qwen3:32b"],
            }));
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Switch model");
            expect(frame).toContain("favorites");
            expect(frame).toContain("recent");
            expect(frame).toContain("Claude Opus 5");
            expect(frame).toContain("qwen3:32b");
            expect(frame).toContain("current");
            for (const gone of ["Sort", "Cutoff", "WA Score", "Filter and sort", "All connected"]) {
                expect(frame).not.toContain(gone);
            }
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the browse row is pinned under the list", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            view.update(handleTuiModelSwitcherKey(started(), { name: "end" }).state!);
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            const lines = frame.split("\n").map((line) => line.trim()).filter(Boolean);
            const at = lines.findIndex((line) => line.startsWith("Browse models"));
            expect(at).toBeGreaterThan(0);
            // It sits under every model, above the footer.
            expect(lines[at - 1]).toContain("qwen3:32b");
            expect(lines.slice(at + 1).join(" ")).toContain("esc close");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an unavailable model is marked in text, not by color alone", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            view.update(started());
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("unavailable");
        } finally {
            setup.renderer.destroy();
        }
    });
});
