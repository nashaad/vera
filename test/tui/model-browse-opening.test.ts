import { describe, expect, test } from "bun:test";

import {
    handleModelBrowseKey,
    handleModelBrowseMenuKey,
    initialModelBrowseScope,
    modelBrowse,
    modelBrowseScope,
} from "../../clients/tui/model-browse.ts";
import { startTuiSettingsPicker, syncTuiModelPicker } from "../../clients/tui/settings-picker.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";

const favorite: PooledModel = {
    provider: "faux",
    model: "test",
    label: "Test model",
    available: true,
    verified: false,
    levels: [],
};

function awaitingFavorites() {
    return modelBrowse({
        ...startTuiSettingsPicker("model", undefined, undefined, undefined),
        tab: initialModelBrowseScope("pool", false),
        browsePendingScope: "pool",
    }, "browse");
}

describe("model browse opening scope", () => {
    test("@core uses All connected without favorites and restores either saved scope with favorites", () => {
        expect(initialModelBrowseScope("pool", false)).toBe("all");
        expect(initialModelBrowseScope("all", false)).toBe("all");
        expect(initialModelBrowseScope("pool", true)).toBe("pool");
        expect(initialModelBrowseScope("all", true)).toBe("all");
    });

    test("resolves the first favorites snapshot once without reacting to later changes", () => {
        const pending = awaitingFavorites();
        expect(pending.tab).toBe("all");
        const stillPending = syncTuiModelPicker(pending, { availableModels: [] });
        expect(stillPending.browsePendingScope).toBe("pool");
        const empty = syncTuiModelPicker(stillPending, { pooled: [] });
        expect(empty.tab).toBe("all");
        expect(empty.browsePendingScope).toBeUndefined();
        expect(syncTuiModelPicker(empty, { pooled: [favorite] }).tab).toBe("all");

        const populated = syncTuiModelPicker(awaitingFavorites(), { pooled: [favorite] });
        expect(populated.tab).toBe("pool");
        expect(populated.browsePendingScope).toBeUndefined();
    });

    test("a scope chosen before the first snapshot is retained", () => {
        const pending = awaitingFavorites();
        const favorites = handleModelBrowseKey(pending, { name: "g", ctrl: true }).state!;
        const recommended = handleModelBrowseKey(favorites, { name: "g", ctrl: true }).state!;
        expect(recommended.tab).toBe("recommended");
        expect(recommended.browsePendingScope).toBeUndefined();
        expect(syncTuiModelPicker(recommended, { pooled: [favorite] }).tab).toBe("recommended");
    });

    test("a Show menu choice before the first snapshot is retained", () => {
        const pending = { ...awaitingFavorites(), modelFocus: "filters" as const };
        const menu = { ...modelBrowseScope(pending), selectedIndex: 1 };
        const chosen = handleModelBrowseMenuKey(menu, { name: "enter" }).state!;
        expect(chosen.parent?.tab).toBe("recommended");
        expect(chosen.parent?.browsePendingScope).toBeUndefined();
        const refreshed = syncTuiModelPicker(chosen, { pooled: [favorite] });
        expect(refreshed.parent?.tab).toBe("recommended");
    });

    test("the Favorites editor discards a pending browse scope", () => {
        const editor = modelBrowse(awaitingFavorites(), "favorites");
        expect(editor.modelBrowse).toBe("favorites");
        expect(editor.title).toBe("Favorites");
        expect(editor.browsePendingScope).toBeUndefined();
        expect(syncTuiModelPicker(editor, { pooled: [favorite] }).modelBrowse).toBe("favorites");
    });
});
