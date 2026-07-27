import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiModelPresets,
    loadTuiThemePreference,
    saveTuiActivityAnimationPreference,
    saveTuiModelPresets,
    saveTuiThemePreference,
} from "../../clients/tui/theme-preference.ts";
import { emptyModelPresetSlots } from "../../clients/tui/model-presets.ts";

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

test("model presets persist beside the other client preferences", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");
    const preset = {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoningEffort: "low",
    } as const;

    expect(loadTuiModelPresets(path)).toEqual([null, null, null, null]);

    saveTuiThemePreference("nightowl", path);
    saveTuiModelPresets([null, preset, null, null], path);

    // The two writers share one file, so neither may drop the other's key.
    expect(loadTuiThemePreference(path)).toBe("nightowl");
    expect(loadTuiModelPresets(path)).toEqual([null, preset, null, null]);
    saveTuiThemePreference("github", path);
    expect(loadTuiModelPresets(path)).toEqual([null, preset, null, null]);

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

    saveTuiModelPresets(emptyModelPresetSlots(), path);
    expect(loadTuiModelPresets(path)).toEqual([null, null, null, null]);
});

test("saving an unrelated preference does not add an empty preset block", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-tui-theme-"));
    const path = join(directory, "tui.json");

    saveTuiThemePreference("orng", path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        theme: "orng",
        animation: "conveyor",
    });
});
