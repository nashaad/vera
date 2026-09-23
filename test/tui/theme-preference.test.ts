import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadModelPickerPreferences,
    saveModelPickerPreferences,
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiRecentSessionId,
    loadTuiSharedSessionGroups,
    loadTuiPersistedAgentPane,
    loadTuiPinnedSessionIds,
    loadTuiExtensionPreference,
    loadTuiThemePreference,
    loadTuiWorkspaceSidebarWidth,
    saveTuiActivityAnimationPreference,
    loadTuiAnimationLevelPreference,
    saveTuiAnimationLevelPreference,
    loadTuiLiveReasoningRowsPreference,
    saveTuiLiveReasoningRowsPreference,
    saveTuiRecentSessionId,
    saveTuiSharedSessionGroups,
    saveTuiPersistedAgentPane,
    saveTuiPinnedSessionIds,
    saveTuiExtensionPreference,
    deleteTuiExtensionPreference,
    saveTuiThemePreference,
    saveTuiWorkspaceSidebarWidth,
} from "../../clients/tui/theme-preference.ts";

test("picker preferences survive other writes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-picker-prefs-")), "tui.json");
    expect(loadModelPickerPreferences(path).view).toBe("standard");
    saveModelPickerPreferences({ view: "detailed", scope: "all", sort: "price" }, path);
    saveTuiThemePreference("nightowl", path);
    expect(loadModelPickerPreferences(path)).toEqual({ view: "detailed", scope: "all", sort: "price" });
    saveModelPickerPreferences({ view: "standard", scope: "pool", sort: "library" }, path);
    writeFileSync(path, JSON.stringify({ model_picker: { view: "bad", scope: "bad", sort: "bad" } }));
    expect(loadModelPickerPreferences(path)).toEqual({ view: "standard", scope: "pool", sort: "library" });
});

test("a durable agent pane persists with its owner and mention", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-pane-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("nightowl", path);
    saveTuiPersistedAgentPane("main-agent", {
        mainAgentId: "main-agent",
        sidebarAgentId: "peer-agent",
        owner: "vera.btw",
        mention: "peer",
        statusLabel: "pair",
    }, path);

    expect(loadTuiPersistedAgentPane("main-agent", path)).toEqual({
        mainAgentId: "main-agent",
        sidebarAgentId: "peer-agent",
        owner: "vera.btw",
        mention: "peer",
        statusLabel: "pair",
    });
    expect(loadTuiThemePreference(path)).toBe("nightowl");

    saveTuiPersistedAgentPane("other-main", {
        mainAgentId: "other-main",
        sidebarAgentId: "other-peer",
        owner: "vera.btw",
    }, path);
    saveTuiPersistedAgentPane("main-agent", undefined, path);
    expect(loadTuiPersistedAgentPane("main-agent", path)).toBeUndefined();
    expect(loadTuiPersistedAgentPane("other-main", path)?.sidebarAgentId)
        .toBe("other-peer");
    expect(loadTuiThemePreference(path)).toBe("nightowl");
});

test("invalid durable pane records are ignored", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-pane-"));
    const path = join(directory, "tui.json");
    writeFileSync(path, JSON.stringify({
        persisted_agent_panes: [{
            main_agent_id: "same",
            sidebar_agent_id: "same",
            owner: "vera.btw",
        }],
    }));

    expect(loadTuiPersistedAgentPane("same", path)).toBeUndefined();
});

test("shared session groups persist as disjoint symmetric pairs", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-shared-"));
    const path = join(directory, "tui.json");

    saveTuiSharedSessionGroups([["main", "assistant"]], path);
    expect(loadTuiSharedSessionGroups(path)).toEqual([["main", "assistant"]]);

    writeFileSync(path, JSON.stringify({
        shared_session_groups: [
            ["main", "assistant"],
            ["main", "duplicate"],
            ["broken"],
        ],
    }));
    expect(loadTuiSharedSessionGroups(path)).toEqual([["main", "assistant"]]);
});

test("TUI theme preference persists outside the engine configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    expect(loadTuiThemePreference(path)).toBe("default");
    expect(loadTuiActivityAnimationPreference(path)).toBe("shimmer");
    saveTuiThemePreference("nightowl", path);
    saveTuiActivityAnimationPreference("symmetric_wave", path);
    expect(loadTuiThemePreference(path)).toBe("nightowl");
    expect(loadTuiActivityAnimationPreference(path)).toBe("symmetric_wave");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "nightowl",
        animation: "symmetric_wave",
        animation_level: 2,
    });

    saveTuiThemePreference("github", path);
    expect(loadTuiActivityAnimationPreference(path)).toBe("symmetric_wave");
});

test("the most recently entered session persists with other TUI preferences", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-recent-session-"));
    const path = join(directory, "tui.json");

    expect(loadTuiRecentSessionId(path)).toBeUndefined();
    saveTuiThemePreference("nightowl", path);
    saveTuiRecentSessionId("session-2", path);

    expect(loadTuiRecentSessionId(path)).toBe("session-2");
    expect(loadTuiThemePreference(path)).toBe("nightowl");
});

test("legacy TUI preferences gain the default animation when saved", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");
    writeFileSync(path, JSON.stringify({ theme: "github" }));

    expect(loadTuiThemePreference(path)).toBe("github");
    expect(loadTuiActivityAnimationPreference(path)).toBe("shimmer");
    saveTuiActivityAnimationPreference("off", path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "github",
        animation: "off",
        animation_level: 2,
    });
});

test("TUI activity animation accepts bounded numeric tuning", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");
    writeFileSync(path, JSON.stringify({
        animation: "symmetric_wave",
        animation_interval_ms: 480,
        animation_width: 7,
    }));

    expect(loadTuiActivityAnimationPreference(path)).toBe("symmetric_wave");
    expect(loadTuiActivityAnimationIntervalPreference(path)).toBe(480);
    expect(loadTuiActivityAnimationWidthPreference(path)).toBe(7);

    writeFileSync(path, JSON.stringify({
        animation: "shimmer",
        animation_interval_ms: 40,
    }));
    expect(loadTuiActivityAnimationPreference(path)).toBe("shimmer");
    expect(loadTuiActivityAnimationIntervalPreference(path)).toBe(40);

    writeFileSync(path, JSON.stringify({
        animation_interval_ms: 20,
        animation_width: 100,
    }));
    expect(loadTuiActivityAnimationIntervalPreference(path)).toBeUndefined();
    expect(loadTuiActivityAnimationWidthPreference(path)).toBeUndefined();
});

test("saving one preference writes no empty blocks for the others", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("orng", path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "orng",
        animation: "shimmer",
        animation_level: 2,
    });
});

test("muted blue is accepted as a persisted theme", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("muted-blue", path);

    expect(loadTuiThemePreference(path)).toBe("muted-blue");
});

test("midnight blue is accepted as a persisted theme", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("midnight-blue", path);

    expect(loadTuiThemePreference(path)).toBe("midnight-blue");
});

test("Midnight Blue II is accepted as a persisted theme", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("midnight-blue-ii", path);

    expect(loadTuiThemePreference(path)).toBe("midnight-blue-ii");
});

test("extension preferences are isolated and share the atomic client file", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-extension-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("github", path);
    saveTuiExtensionPreference("first.extension", "slots", [1, 2], path);
    saveTuiExtensionPreference("second.extension", "slots", ["other"], path);

    expect(loadTuiExtensionPreference(
        "first.extension",
        "slots",
        path,
    )).toEqual([1, 2]);
    expect(loadTuiExtensionPreference(
        "second.extension",
        "slots",
        path,
    )).toEqual(["other"]);
    expect(loadTuiThemePreference(path)).toBe("github");

    deleteTuiExtensionPreference("first.extension", "slots", path);
    expect(loadTuiExtensionPreference(
        "first.extension",
        "slots",
        path,
    )).toBeUndefined();
    expect(loadTuiExtensionPreference(
        "second.extension",
        "slots",
        path,
    )).toEqual(["other"]);
});

test("pinned sessions persist beside the rest of the client preferences", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-pins-"));
    const path = join(directory, "tui.json");

    expect(loadTuiPinnedSessionIds(path)).toEqual([]);
    saveTuiThemePreference("nightowl", path);
    saveTuiPinnedSessionIds(["one", "two"], path);

    expect(loadTuiPinnedSessionIds(path)).toEqual(["one", "two"]);
    expect(loadTuiThemePreference(path)).toBe("nightowl");

    saveTuiPinnedSessionIds([], path);
    expect(loadTuiPinnedSessionIds(path)).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")))
        .not.toHaveProperty("pinned_session_ids");
});

test("a malformed pin list is read as no pins", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-pins-bad-"));
    const path = join(directory, "tui.json");
    writeFileSync(path, JSON.stringify({ pinned_session_ids: [1, "", "ok"] }));
    expect(loadTuiPinnedSessionIds(path)).toEqual(["ok"]);
});

test("the workspace dock width persists", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-workspace-width-"));
    const path = join(directory, "tui.json");

    expect(loadTuiWorkspaceSidebarWidth(path)).toBeUndefined();
    saveTuiWorkspaceSidebarWidth(58, path);

    expect(loadTuiWorkspaceSidebarWidth(path)).toBe(58);
});

test("a stored dock open state is dropped on the next write", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-workspace-dock-"));
    const path = join(directory, "tui.json");
    writeFileSync(path, JSON.stringify({ theme: "nightowl", workspace_sidebar_docked: true }));

    saveTuiWorkspaceSidebarWidth(58, path);

    expect(loadTuiThemePreference(path)).toBe("nightowl");
    expect(JSON.parse(readFileSync(path, "utf8")))
        .not.toHaveProperty("workspace_sidebar_docked");
});

test("animation level is its own setting and leaves the transcript animation alone", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    writeFileSync(path, JSON.stringify({ theme: "github", animation: "braille" }));
    expect(loadTuiAnimationLevelPreference(path)).toBe(2);

    saveTuiAnimationLevelPreference(0, path);
    expect(loadTuiAnimationLevelPreference(path)).toBe(0);
    expect(loadTuiActivityAnimationPreference(path)).toBe("braille");
    saveTuiActivityAnimationPreference("off", path);
    expect(loadTuiAnimationLevelPreference(path)).toBe(0);
    saveTuiAnimationLevelPreference(3, path);
    expect(loadTuiAnimationLevelPreference(path)).toBe(3);
    expect(loadTuiActivityAnimationPreference(path)).toBe("off");
});

test("live reasoning rows default to one, survive other writes, and ignore bad values", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-reasoning-rows-prefs-")), "tui.json");
    expect(loadTuiLiveReasoningRowsPreference(path)).toBe(1);

    saveTuiLiveReasoningRowsPreference(8, path);
    saveTuiThemePreference("github", path);
    expect(loadTuiLiveReasoningRowsPreference(path)).toBe(8);
    saveTuiLiveReasoningRowsPreference("all", path);
    expect(loadTuiLiveReasoningRowsPreference(path)).toBe("all");
    saveTuiLiveReasoningRowsPreference(0, path);
    expect(loadTuiLiveReasoningRowsPreference(path)).toBe(0);

    saveTuiLiveReasoningRowsPreference(1, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("live_reasoning_rows");

    writeFileSync(path, JSON.stringify({ live_reasoning_rows: 4 }));
    expect(loadTuiLiveReasoningRowsPreference(path)).toBe(1);
});
