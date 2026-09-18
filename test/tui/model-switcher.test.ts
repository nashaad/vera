import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
    FAVORITES_GROUP,
    RECENT_GROUP,
    createTuiModelSwitcherView,
    handleTuiModelSwitcherKey,
    modelSwitcherKey,
    refreshedTuiModelSwitcher,
    startTuiModelSwitcher,
    switcherEmptyMessage,
    searchedTuiModelSwitcher,
    switcherFooterText,
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
        expect(last.selectedIndex).toBe(rows.length - 1);
        expect(handleTuiModelSwitcherKey(last, { name: "down" }).state?.selectedIndex)
            .toBe(rows.length - 1);
    });

    test("no browse control is bound: scope, sort and cutoff keys fall through", () => {
        for (const key of [{ name: "g", ctrl: true }, { name: "s", ctrl: true }, { name: "left" }, { name: "right" }]) {
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

    test("a seeded row is listed under favorites", () => {
        const state = startTuiModelSwitcher(seeded);
        expect(state.rows.map((row) => row.label)).toEqual([
            "Claude Opus 5",
            "GPT-5.6",
            "Claude Sonnet 5",
        ]);
        expect(state.groups).toEqual([FAVORITES_GROUP, FAVORITES_GROUP, "anthropic"]);
    });

    test("ctrl+f on a seeded row offers to add it, not to remove it", () => {
        const state = startTuiModelSwitcher(seeded);
        expect(switcherFooterText(state)).toContain("^f favorite");
        expect(handleTuiModelSwitcherKey(state, { name: "f", ctrl: true }).favorite?.label)
            .toBe("Claude Opus 5");
    });
});

describe("model switcher favoriting", () => {
    test("a toggled row keeps the cursor after the list reorders", () => {
        const state = handleTuiModelSwitcherKey(
            handleTuiModelSwitcherKey(started(), { name: "end" }).state!,
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
        const last = handleTuiModelSwitcherKey(state, { name: "end" }).state!;
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
