import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadTuiActivityAnimationPreference,
    loadTuiActivityAnimationIntervalPreference,
    loadTuiActivityAnimationWidthPreference,
    loadTuiThemePreference,
    saveTuiActivityAnimationPreference,
    saveTuiThemePreference,
} from "../../clients/tui/theme-preference.ts";

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
