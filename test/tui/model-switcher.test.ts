import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
    MODEL_SWITCHER_MATCHES,
    MODEL_SWITCHER_SHORTLIST,
    browseRowLabel,
    createTuiModelSwitcherView,
    handleTuiModelSwitcherKey,
    modelSwitcherKey,
    onSwitcherBrowseRow,
    refreshedTuiModelSwitcher,
    startTuiModelSwitcher,
    switcherEmptyMessage,
    searchedTuiModelSwitcher,
    switcherFooterText,
    switcherRowProvider,
    switcherScope,
    switcherScopeLabel,
    switcherStop,
    switcherUnlistedHint,
    type TuiModelSwitcherRow,
    type TuiModelSwitcherState,
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
    test("the current model leads, then favorites, then recents", () => {
        const state = started({
            current: "openai/gpt-5.6-mini",
            recents: ["ollama/qwen3:32b", "anthropic/claude-sonnet-5"],
        });
        expect(state.rows.map((row) => row.label)).toEqual([
            "GPT-5.6 mini",
            "Claude Opus 5",
            "GPT-5.6",
            "qwen3:32b",
            "Claude Sonnet 5",
        ]);
    });

    test("nothing is listed twice when a recent is also a favorite", () => {
        const state = started({ recents: ["openai/gpt-5.6"] });
        const keys = state.rows.map(modelSwitcherKey);
        expect(new Set(keys).size).toBe(keys.length);
    });

    test("a model nobody asked for is left to Browse models", () => {
        const state = started();
        expect(state.rows.map((row) => row.label)).toEqual(["Claude Opus 5", "GPT-5.6"]);
        expect(state.hidden).toBe(rows.length - 2);
    });

    test("the resting list stops at the shortlist, however many are connected", () => {
        const many = Array.from({ length: 30 }, (_, at) => ({
            provider: "openrouter",
            model: `m${at}`,
            label: `Model ${at}`,
            ...(at === 0 ? { favorite: true } : {}),
        }));
        const state = startTuiModelSwitcher(many, { recents: many.map(modelSwitcherKey) });
        expect(state.rows.length).toBe(MODEL_SWITCHER_SHORTLIST);
        expect(state.hidden).toBe(many.length - MODEL_SWITCHER_SHORTLIST);
    });

    test("every favorite is listed, even past the shortlist", () => {
        const many = Array.from({ length: MODEL_SWITCHER_SHORTLIST + 5 }, (_, at) => ({
            provider: "openrouter",
            model: `m${at}`,
            label: `Model ${at}`,
            favorite: true,
        }));
        const state = startTuiModelSwitcher(many, { recents: ["openrouter/m0"] });
        expect(state.rows.length).toBe(many.length);
        expect(state.hidden).toBe(0);
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

    test("typing reaches past the shortlist into the whole catalog", () => {
        const searching = typed("gpt");
        expect(searching.rows.map((row) => row.label)).toEqual(["GPT-5.6", "GPT-5.6 mini"]);
        expect(searching.hidden).toBe(0);
        expect(browseRowLabel(searching)).toBe("Browse models");
    });

    test("a search past its limit says how many matches Browse models holds", () => {
        const many = Array.from({ length: MODEL_SWITCHER_MATCHES + 3 }, (_, at) => ({
            provider: "openrouter",
            model: `glm-${at}`,
            label: `GLM ${at}`,
        }));
        const searching = searchedTuiModelSwitcher(startTuiModelSwitcher(many), "glm");
        expect(searching.rows.length).toBe(MODEL_SWITCHER_MATCHES);
        expect(browseRowLabel(searching)).toBe("Browse models · 3 more matches");
    });

    test("a match on the model id reaches a model the label does not name", () => {
        expect(typed("sonnet").rows.map((row) => row.label)).toEqual(["Claude Sonnet 5"]);
    });

    test("clearing the search restores the resting list", () => {
        expect(typed("gpt")).not.toEqual(started());
        expect(searchedTuiModelSwitcher(typed("gpt"), "").rows).toEqual(started().rows);
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
        expect(last.selectedIndex).toBe(state.rows.length);
        expect(handleTuiModelSwitcherKey(last, { name: "down" }).state?.selectedIndex)
            .toBe(state.rows.length);
    });

    test("a shortlist shorter than a page clamps ctrl+d to the browse row", () => {
        const many = Array.from({ length: 5 }, (_, index) => ({
            provider: "openai",
            model: `m${index}`,
            label: `M${index}`,
        }));
        const state = startTuiModelSwitcher(many);
        const down = handleTuiModelSwitcherKey(state, { name: "d", ctrl: true }).state!;
        expect(down.selectedIndex).toBe(state.rows.length);
        expect(handleTuiModelSwitcherKey(down, { name: "u", ctrl: true }).state?.selectedIndex)
            .toBe(0);
    });

    test("ctrl+k leaves for the browse page", () => {
        const transition = handleTuiModelSwitcherKey(started(), { name: "k", ctrl: true });
        expect(transition.browse).toBe(true);
        expect(transition.handled).toBe(true);
        expect(transition.state).toBeUndefined();
    });

    test("the footer names paging once the keys belong to the list", () => {
        const list = handleTuiModelSwitcherKey(started(), { name: "down" }).state!;
        expect(switcherFooterText(list)).toContain("Ctrl+U/D page");
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

    test("the cursor reaches the browse row one past the last model", () => {
        const last = handleTuiModelSwitcherKey(started(), { name: "end" }).state!;
        expect(onSwitcherBrowseRow(last)).toBe(true);
        expect(last.rows[last.selectedIndex]).toBeUndefined();
        expect(handleTuiModelSwitcherKey(last, { name: "return" }).browse).toBe(true);
        expect(handleTuiModelSwitcherKey(last, { name: "down" }).state?.selectedIndex)
            .toBe(last.selectedIndex);
    });

    test("the sort key falls through: the switcher does not order the list", () => {
        expect(handleTuiModelSwitcherKey(started(), { name: "s", ctrl: true }).handled)
            .toBe(false);
    });
});

describe("model switcher scope", () => {
    const resting = (): TuiModelSwitcherState =>
        started({ current: "openai/gpt-5.6", recents: ["anthropic/claude-sonnet-5"] });
    const scoped = (state: TuiModelSwitcherState): TuiModelSwitcherState =>
        handleTuiModelSwitcherKey(state, { name: "g", ctrl: true }).state!;

    test("ctrl+g opens every connected model, grouped by where it comes from", () => {
        const all = scoped(resting());
        expect(switcherScope(all)).toBe("all");
        expect(all.rows.map((row) => row.label)).toEqual([
            "GPT-5.6",
            "Claude Opus 5",
            "Claude Sonnet 5",
            "GPT-5.6 mini",
            "qwen3:32b",
        ]);
        expect(all.headings?.filter((heading) => heading !== undefined))
            .toEqual(["Favorites", "Recent", "openai", "ollama"]);
        expect(switcherScopeLabel(all)).toBe("All connected models");
        expect(switcherScopeLabel(resting())).toBe("Favorites");
    });

    test("nothing is left over once the list holds everything", () => {
        expect(resting().hidden).toBeGreaterThan(0);
        expect(scoped(resting()).hidden).toBe(0);
    });

    test("ctrl+g again returns the short list", () => {
        const back = scoped(scoped(resting()));
        expect(switcherScope(back)).toBe("favorites");
        expect(back.rows).toEqual(resting().rows);
        expect(back.headings?.every((heading) => heading === undefined)).toBe(true);
    });

    test("the selected model is held across the toggle", () => {
        const list = handleTuiModelSwitcherKey(resting(), { name: "down" }).state!;
        const held = list.rows[list.selectedIndex]!;
        const all = scoped(list);
        expect(all.rows[all.selectedIndex]).toEqual(held);
    });

    test("a search shows its matches ungrouped whatever the scope", () => {
        const found = searchedTuiModelSwitcher(scoped(resting()), "opus");
        expect(found.rows.map((row) => row.label)).toEqual(["Claude Opus 5"]);
        expect(found.headings).toEqual([undefined]);
    });
});

describe("model switcher card", () => {
    test("the card keeps its place when ctrl+g fills the list", async () => {
        const setup = await createTestRenderer({ width: 100, height: 40 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            // The card is one size: the title and the band below it never move.
            const edges = async (
                state: TuiModelSwitcherState,
            ): Promise<readonly number[]> => {
                view.update(state);
                await setup.renderOnce();
                const lines = setup.captureCharFrame().split("\n");
                return [
                    lines.findIndex((line) => line.includes("Switch model")),
                    lines.findIndex((line) => line.includes("Browse models")),
                ];
            };
            const resting = startTuiModelSwitcher(rows, {
                current: "openai/gpt-5.6",
                recents: ["anthropic/claude-sonnet-5"],
            });
            const at = await edges(resting);
            expect(at[0]).toBeGreaterThan(0);
            expect(at[1]).toBeGreaterThan(at[0]!);
            const all = handleTuiModelSwitcherKey(resting, { name: "g", ctrl: true }).state!;
            expect(await edges(all)).toEqual(at);
            expect(await edges(searchedTuiModelSwitcher(resting, "claude"))).toEqual(at);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("model switcher with no favorites", () => {
    const none: readonly TuiModelSwitcherRow[] = [
        { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5" },
        { provider: "openai", model: "gpt-5.6", label: "GPT-5.6" },
    ];

    test("the list stays empty and says how to fill it", () => {
        const state = startTuiModelSwitcher(none, {
            current: "openai/gpt-5.6",
            recents: ["anthropic/claude-opus-5"],
        });
        expect(state.rows).toEqual([]);
        expect(switcherEmptyMessage(state)).toBe(
            "Your favorite models land here."
                + " Ctrl+K to go get some, or type a name if you know one.",
        );
        expect(switcherFooterText(state)).toBe("type search · ⏎ browse · esc close");
    });

    test("typing still finds every model", () => {
        const state = searchedTuiModelSwitcher(startTuiModelSwitcher(none), "opus");
        expect(state.rows.map((row) => row.label)).toEqual(["Claude Opus 5"]);
    });
});

describe("model switcher unlisted providers", () => {
    const connected: readonly TuiModelSwitcherRow[] = [
        { provider: "openrouter", model: "openai/gpt-5.6-luna", label: "OpenAI: GPT-5.6 Luna", providerLabel: "OpenRouter", favorite: true },
        { provider: "openai-codex", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", providerLabel: "OpenAI Codex" },
    ];

    test("a provider with no row in the resting list is named under it", () => {
        expect(switcherUnlistedHint(startTuiModelSwitcher(connected)))
            .toBe("OpenAI Codex is connected. Ctrl+K lists its models.");
    });

    test("two of them share one line", () => {
        const state = startTuiModelSwitcher([
            ...connected,
            { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", providerLabel: "Anthropic" },
        ]);
        expect(switcherUnlistedHint(state))
            .toBe("OpenAI Codex and Anthropic are connected. Ctrl+K lists their models.");
    });

    test("a provider already in the list says nothing", () => {
        const state = startTuiModelSwitcher(connected, {
            recents: ["openai-codex/gpt-5.6-luna"],
        });
        expect(switcherUnlistedHint(state)).toBeUndefined();
    });

    test("a search answers for itself", () => {
        const state = searchedTuiModelSwitcher(startTuiModelSwitcher(connected), "luna");
        expect(switcherUnlistedHint(state)).toBeUndefined();
    });

    test("the line is drawn between the list and the rule", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            view.update(startTuiModelSwitcher(connected));
            await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n")
                .map((line) => line.trim()).filter(Boolean);
            const at = lines.findIndex((line) =>
                line === "OpenAI Codex is connected. Ctrl+K lists its models.");
            expect(at).toBeGreaterThan(0);
            expect(lines[at - 1]).toContain("GPT-5.6 Luna");
            expect(lines[at + 1]).toMatch(/^\u2500+$/);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("model switcher favoriting", () => {
    test("a toggled row keeps the cursor after the list reorders", () => {
        const opened = started({ recents: ["openai/gpt-5.6-mini"] });
        const atBrowse = handleTuiModelSwitcherKey(opened, { name: "end" }).state!;
        const state = handleTuiModelSwitcherKey(atBrowse, { name: "up" }).state!;
        const held = state.rows[state.selectedIndex]!;
        expect(held.label).toBe("GPT-5.6 mini");
        const promoted = rows.map((row) =>
            modelSwitcherKey(row) === modelSwitcherKey(held) ? { ...row, favorite: true } : row
        );
        const next = refreshedTuiModelSwitcher(state, promoted, state.recents, "Added to favorites");
        expect(next.rows[next.selectedIndex]?.label).toBe("GPT-5.6 mini");
        expect(next.rows[next.selectedIndex]?.favorite).toBe(true);
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

    test("a late recents reply joins the list without moving the cursor", () => {
        const state = started();
        const held = state.rows[state.selectedIndex]!;
        const next = refreshedTuiModelSwitcher(state, state.allRows, ["ollama/qwen3:32b"]);
        expect(next.recents).toEqual(["ollama/qwen3:32b"]);
        expect(next.rows.map((row) => row.label)).toContain("qwen3:32b");
        expect(next.rows[next.selectedIndex]?.label).toBe(held.label);
    });

    test("the footer names the action the highlighted row would take", () => {
        const state = started({ recents: ["openai/gpt-5.6-mini"] });
        expect(switcherFooterText(state)).toContain("Ctrl+F unfavorite");
        const last = handleTuiModelSwitcherKey(
            handleTuiModelSwitcherKey(state, { name: "end" }).state!,
            { name: "up" },
        ).state!;
        expect(switcherFooterText(last)).toContain("Ctrl+F favorite");
    });
});

describe("model switcher rendering", () => {
    test("the dialog numbers its rows and carries no headings or browse controls", async () => {
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
            expect(frame).toContain("Claude Opus 5");
            expect(frame).toContain("qwen3:32b");
            // Rows are bare: no number column, since no key picks a row by number.
            expect(frame.split("\n").filter((line) => /^\s*\d\s+\S/.test(line))).toEqual([]);
            // The caption names what the list is; the old group headings are gone.
            expect(frame).toContain("Your model, your favorites, then what you used last.");
            const headings = frame.split("\n").map((line) => line.trim());
            for (const gone of ["favorites", "recent", "Recommended", "All models"]) {
                expect(headings).not.toContain(gone);
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
            // The caret marks it as the one button among the model rows.
            const at = lines.findIndex((line) => line.startsWith("\u203a Browse models"));
            expect(at).toBeGreaterThan(0);
            // A rule separates it from the models, and the footer follows it.
            expect(lines[at - 1]).toMatch(/^\u2500+$/);
            expect(lines.slice(0, at - 1).join(" ")).toContain("GPT-5.6");
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
            view.update(started({ recents: ["ollama/qwen3:32b"] }));
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("unavailable");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a list taller than the card says how many rows sit above and below", async () => {
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        const many = Array.from({ length: 30 }, (_, at) => ({
            provider: "openrouter", model: `m${at}`, label: `Model ${at}`, favorite: true,
        }));
        try {
            const state = startTuiModelSwitcher(many);
            view.update(state);
            await setup.renderOnce();
            const top = setup.captureCharFrame();
            expect(top).toMatch(/\d+ more below/);
            expect(top).not.toMatch(/\d+ more above/);
            view.update({ ...state, focus: "list", selectedIndex: 15 });
            await setup.renderOnce();
            const middle = setup.captureCharFrame();
            expect(middle).toMatch(/\d+ more above/);
            expect(middle).toMatch(/\d+ more below/);
            expect(middle).toContain("Model 15");
        } finally {
            setup.renderer.destroy();
        }
    });
});

test("only a model listed more than once names its provider", () => {
    const allRows = [
        { provider: "openai-codex", model: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
        { provider: "openrouter", model: "openai/gpt-5.6-luna", label: "OpenAI: GPT-5.6 Luna" },
        { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ];
    const state = { ...startTuiModelSwitcher(allRows), rows: allRows };
    expect(allRows.map((row) => switcherRowProvider(state, row)))
        .toEqual(["openai-codex", "openrouter", undefined]);
});

test("a twin left off the list does not count", () => {
    const allRows = [
        { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
        { provider: "openrouter", model: "deepseek/deepseek-v4-pro", label: "DeepSeek: DeepSeek V4 Pro" },
    ];
    const state = { ...startTuiModelSwitcher(allRows), rows: allRows.slice(0, 1) };
    expect(switcherRowProvider(state, allRows[0]!)).toBeUndefined();
});
