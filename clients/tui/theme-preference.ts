import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { TuiThemeName } from "./theme.ts";
import type { TuiActivityAnimation } from "./activity-pulse.ts";
import {
    modelPresetSlotsForDisk,
    parseModelPresetSlots,
    type DiskModelPresetSlots,
    type ModelPresetSlots,
} from "./model-presets.ts";

// Every client preference shares one file and one writer. A second module doing
// its own read-modify-write here would drop whatever the other had just saved,
// so new preferences are added to this interface rather than to a file of their
// own.
interface TuiClientPreferences {
    readonly theme: TuiThemeName;
    readonly animation: TuiActivityAnimation;
    readonly animation_interval_ms?: number;
    readonly animation_width?: number;
    readonly model_presets?: DiskModelPresetSlots;
}

export function tuiThemePreferencePath(): string {
    return join(homedir(), ".vera", "tui.json");
}

export function loadTuiThemePreference(
    path = tuiThemePreferencePath(),
): TuiThemeName {
    return loadTuiClientPreferences(path).theme;
}

export function saveTuiThemePreference(
    theme: TuiThemeName,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        theme,
    }, path);
}

export function loadTuiActivityAnimationPreference(
    path = tuiThemePreferencePath(),
): TuiActivityAnimation {
    return loadTuiClientPreferences(path).animation;
}

export function saveTuiActivityAnimationPreference(
    animation: TuiActivityAnimation,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        animation,
    }, path);
}

export function loadTuiActivityAnimationIntervalPreference(
    path = tuiThemePreferencePath(),
): number | undefined {
    return loadTuiClientPreferences(path).animation_interval_ms;
}

export function loadTuiActivityAnimationWidthPreference(
    path = tuiThemePreferencePath(),
): number | undefined {
    return loadTuiClientPreferences(path).animation_width;
}

export function loadTuiModelPresets(
    path = tuiThemePreferencePath(),
): ModelPresetSlots {
    return parseModelPresetSlots(loadTuiClientPreferences(path).model_presets);
}

export function saveTuiModelPresets(
    slots: ModelPresetSlots,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        model_presets: modelPresetSlotsForDisk(slots),
    }, path);
}

function loadTuiClientPreferences(path: string): TuiClientPreferences {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (typeof value === "object" && value !== null) {
            const theme = Reflect.get(value, "theme");
            const animation = Reflect.get(value, "animation");
            const interval = boundedInteger(
                Reflect.get(value, "animation_interval_ms"),
                80,
                2_000,
            );
            const width = boundedInteger(
                Reflect.get(value, "animation_width"),
                2,
                15,
            );
            // Absent presets stay absent rather than becoming four nulls, so
            // saving an unrelated preference does not grow the file with a
            // block the user never asked for.
            const presets = Reflect.get(value, "model_presets");
            return {
                theme: isTuiThemeName(theme) ? theme : "default",
                animation: isTuiActivityAnimation(animation)
                    ? animation
                    : "conveyor",
                ...(interval === undefined
                    ? {}
                    : { animation_interval_ms: interval }),
                ...(width === undefined ? {} : { animation_width: width }),
                ...(Array.isArray(presets)
                    ? {
                        model_presets: modelPresetSlotsForDisk(
                            parseModelPresetSlots(presets),
                        ),
                    }
                    : {}),
            };
        }
    } catch {
        // Missing or malformed client preferences must not prevent startup.
    }
    return { theme: "default", animation: "conveyor" };
}

function saveTuiClientPreferences(
    preferences: TuiClientPreferences,
    path: string,
): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporaryPath, path);
}

function boundedInteger(
    value: unknown,
    minimum: number,
    maximum: number,
): number | undefined {
    return typeof value === "number"
            && Number.isInteger(value)
            && value >= minimum
            && value <= maximum
        ? value
        : undefined;
}

export function isTuiThemeName(value: unknown): value is TuiThemeName {
    return value === "default"
        || value === "system"
        || value === "orng"
        || value === "palenight"
        || value === "synthwave"
        || value === "nightowl"
        || value === "github";
}

export function isTuiActivityAnimation(
    value: unknown,
): value is TuiActivityAnimation {
    return value === "conveyor"
        || value === "symmetric_wave"
        || value === "braille"
        || value === "off";
}
