import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { JsonValue } from "../../src/sdk/hooks.ts";
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
    readonly recent_session_id?: string;
    readonly animation_interval_ms?: number;
    readonly animation_width?: number;
    readonly model_presets?: DiskModelPresetSlots;
    readonly extensions?: Readonly<
        Record<string, Readonly<Record<string, JsonValue>>>
    >;
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

export function loadTuiRecentSessionId(
    path = tuiThemePreferencePath(),
): string | undefined {
    return loadTuiClientPreferences(path).recent_session_id;
}

export function saveTuiRecentSessionId(
    sessionId: string,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        recent_session_id: sessionId,
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

export function loadTuiExtensionPreference(
    extensionId: string,
    key: string,
    path = tuiThemePreferencePath(),
): JsonValue | undefined {
    const preferences = loadTuiClientPreferences(path);
    const value = preferences.extensions?.[extensionId]?.[key];
    if (value !== undefined) {
        return value;
    }
    // The bundled extension keeps presets saved by the former built-in
    // implementation visible on its first run.
    return extensionId === "vera.model-presets"
            && key === "slots"
            && preferences.model_presets !== undefined
        ? structuredClone(preferences.model_presets) as unknown as JsonValue
        : undefined;
}

export function saveTuiExtensionPreference(
    extensionId: string,
    key: string,
    value: JsonValue,
    path = tuiThemePreferencePath(),
): void {
    const preferences = loadTuiClientPreferences(path);
    saveTuiClientPreferences({
        ...preferences,
        extensions: {
            ...preferences.extensions,
            [extensionId]: {
                ...preferences.extensions?.[extensionId],
                [key]: structuredClone(value),
            },
        },
    }, path);
}

export function deleteTuiExtensionPreference(
    extensionId: string,
    key: string,
    path = tuiThemePreferencePath(),
): void {
    const preferences = loadTuiClientPreferences(path);
    const namespace = { ...preferences.extensions?.[extensionId] };
    delete namespace[key];
    const extensions = { ...preferences.extensions };
    if (Object.keys(namespace).length === 0) {
        delete extensions[extensionId];
    } else {
        extensions[extensionId] = namespace;
    }
    const { extensions: _previous, ...withoutExtensions } = preferences;
    saveTuiClientPreferences({
        ...withoutExtensions,
        ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
    }, path);
}

function loadTuiClientPreferences(path: string): TuiClientPreferences {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (typeof value === "object" && value !== null) {
            const theme = Reflect.get(value, "theme");
            const animation = Reflect.get(value, "animation");
            const recentSessionId = Reflect.get(value, "recent_session_id");
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
            const extensions = parseExtensionPreferences(
                Reflect.get(value, "extensions"),
            );
            return {
                theme: isTuiThemeName(theme) ? theme : "default",
                animation: isTuiActivityAnimation(animation)
                    ? animation
                    : "conveyor",
                ...(typeof recentSessionId === "string"
                        && recentSessionId.length > 0
                    ? { recent_session_id: recentSessionId }
                    : {}),
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
                ...(extensions === undefined ? {} : { extensions }),
            };
        }
    } catch {
        // Missing or malformed client preferences must not prevent startup.
    }
    return { theme: "default", animation: "conveyor" };
}

function parseExtensionPreferences(
    value: unknown,
): TuiClientPreferences["extensions"] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const extensions: Record<string, Record<string, JsonValue>> = {};
    for (const [extensionId, rawNamespace] of Object.entries(value)) {
        if (
            typeof rawNamespace !== "object"
            || rawNamespace === null
            || Array.isArray(rawNamespace)
        ) {
            continue;
        }
        const namespace: Record<string, JsonValue> = {};
        for (const [key, candidate] of Object.entries(rawNamespace)) {
            if (isJsonValue(candidate)) {
                namespace[key] = candidate;
            }
        }
        if (Object.keys(namespace).length > 0) {
            extensions[extensionId] = namespace;
        }
    }
    return Object.keys(extensions).length === 0 ? undefined : extensions;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
    ) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    return typeof value === "object"
        && value !== null
        && Object.values(value).every(isJsonValue);
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
        || value === "muted-blue"
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
