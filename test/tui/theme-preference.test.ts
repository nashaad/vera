import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiQuickslots,
    loadTuiRecentSessionId,
    loadTuiExtensionPreference,
    loadTuiThemePreference,
    saveTuiActivityAnimationPreference,
    saveTuiQuickslots,
    saveTuiRecentSessionId,
    saveTuiExtensionPreference,
    deleteTuiExtensionPreference,
    saveTuiThemePreference,
} from "../../clients/tui/theme-preference.ts";
import { emptyQuickslots } from "../../clients/tui/quickslots.ts";

test("TUI theme preference persists outside the engine configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    expect(loadTuiThemePreference(path)).toBe("default");
    expect(loadTuiActivityAnimationPreference(path)).toBe("conveyor");
    saveTuiThemePreference("nightowl", path);
    saveTuiActivityAnimationPreference("symmetric_wave", path);
    expect(loadTuiThemePreference(path)).toBe("nightowl");
    expect(loadTuiActivityAnimationPreference(path)).toBe("symmetric_wave");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "nightowl",
        animation: "symmetric_wave",
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
    expect(loadTuiActivityAnimationPreference(path)).toBe("conveyor");
    saveTuiActivityAnimationPreference("off", path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "github",
        animation: "off",
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
        animation_interval_ms: 20,
        animation_width: 100,
    }));
    expect(loadTuiActivityAnimationIntervalPreference(path)).toBeUndefined();
    expect(loadTuiActivityAnimationWidthPreference(path)).toBeUndefined();
});

test("quickslots persist beside the other client preferences", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");
    const quickslot = {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoningEffort: "low",
    } as const;

    expect(loadTuiQuickslots(path)).toEqual([null, null, null, null]);

    saveTuiThemePreference("nightowl", path);
    saveTuiQuickslots([null, quickslot, null, null], path);

    // The two writers share one file, so neither may drop the other's key.
    expect(loadTuiThemePreference(path)).toBe("nightowl");
    expect(loadTuiQuickslots(path)).toEqual([null, quickslot, null, null]);
    saveTuiThemePreference("github", path);
    expect(loadTuiQuickslots(path)).toEqual([null, quickslot, null, null]);

    expect(JSON.parse(readFileSync(path, "utf8")).model_presets).toEqual([
        null,
        {
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            reasoning_effort: "low",
        },
        null,
        null,
    ]);
    expect(loadTuiExtensionPreference(
        "vera.model-presets",
        "slots",
        path,
    )).toEqual(JSON.parse(readFileSync(path, "utf8")).model_presets);

    saveTuiQuickslots(emptyQuickslots(), path);
    expect(loadTuiQuickslots(path)).toEqual([null, null, null, null]);
});

test("saving an unrelated preference does not add an empty quickslot block", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("orng", path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "orng",
        animation: "conveyor",
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
