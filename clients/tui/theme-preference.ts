import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { JsonValue } from "../../src/sdk/hooks.ts";
import { isTuiThemeName, type TuiThemeName } from "./theme.ts";
import type { TuiActivityAnimation } from "./activity-pulse.ts";
import { DEFAULT_ANIMATION_LEVEL, isTuiAnimationLevel, type TuiAnimationLevel } from "./activity-bar.ts";
import { veraProfileDirectory } from "../../src/profile-paths.ts";

export const DEFAULT_LIVE_REASONING_ROWS = 1;
export const MAX_LIVE_REASONING_ROWS = 8;

interface TuiClientPreferences {
    readonly model_picker?: ModelPickerPreferences;
    readonly theme: TuiThemeName;
    readonly animation: TuiActivityAnimation;
    readonly animation_level: TuiAnimationLevel;
    // Stored only when it differs from the default of one row.
    readonly live_reasoning_rows?: number;
    readonly recent_session_id?: string;
    readonly animation_interval_ms?: number;
    readonly animation_width?: number;
    readonly sidebar_width?: number;
    readonly workspace_sidebar_width?: number;
    readonly shared_session_groups?: readonly (readonly [string, string])[];
    readonly pinned_session_ids?: readonly string[];
    readonly persisted_agent_panes?: readonly DiskPersistedAgentPane[];
    readonly keybindings?: Readonly<Record<string, readonly string[]>>;
    readonly extensions?: Readonly<
        Record<string, Readonly<Record<string, JsonValue>>>
    >;
}

export interface ModelPickerPreferences {
    readonly view: "standard" | "detailed";
    readonly scope: "pool" | "all";
    readonly sort: "library" | "az" | "price";
}

function parseModelPickerPreferences(value: unknown): ModelPickerPreferences {
    const row = typeof value === "object" && value !== null ? value : {};
    const sort = Reflect.get(row, "sort");
    return {
        view: Reflect.get(row, "view") === "detailed" ? "detailed" : "standard",
        scope: Reflect.get(row, "scope") === "all" ? "all" : "pool",
        sort: sort === "az" || sort === "price" ? sort : "library",
    };
}

export function loadModelPickerPreferences(path = tuiThemePreferencePath()): ModelPickerPreferences {
    return parseModelPickerPreferences(loadTuiClientPreferences(path).model_picker);
}

export function saveModelPickerPreferences(value: ModelPickerPreferences, path = tuiThemePreferencePath()): void {
    const existing = loadTuiClientPreferences(path);
    saveTuiClientPreferences({ ...existing, model_picker: { ...existing.model_picker, ...value } }, path);
}

interface DiskPersistedAgentPane {
    readonly main_agent_id: string;
    readonly sidebar_agent_id: string;
    readonly owner: string;
    readonly mention?: string;
    readonly status_label?: string;
}

export interface TuiPersistedAgentPane {
    readonly mainAgentId: string;
    readonly sidebarAgentId: string;
    readonly owner: string;
    readonly mention?: string;
    readonly statusLabel?: string;
}

export function tuiThemePreferencePath(): string {
    return join(veraProfileDirectory(), "tui.json");
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

export function loadTuiAnimationLevelPreference(
    path = tuiThemePreferencePath(),
): TuiAnimationLevel {
    return loadTuiClientPreferences(path).animation_level;
}

export function saveTuiAnimationLevelPreference(
    level: TuiAnimationLevel,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        animation_level: level,
    }, path);
}

export function loadTuiLiveReasoningRowsPreference(
    path = tuiThemePreferencePath(),
): number {
    return loadTuiClientPreferences(path).live_reasoning_rows ?? DEFAULT_LIVE_REASONING_ROWS;
}

export function saveTuiLiveReasoningRowsPreference(
    rows: number,
    path = tuiThemePreferencePath(),
): void {
    const { live_reasoning_rows: _previous, ...rest } = loadTuiClientPreferences(path);
    const stored = parseLiveReasoningRows(rows);
    saveTuiClientPreferences({
        ...rest,
        ...(stored === undefined || stored === DEFAULT_LIVE_REASONING_ROWS
            ? {}
            : { live_reasoning_rows: stored }),
    }, path);
}

function parseLiveReasoningRows(value: unknown): number | undefined {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= 0
        && value <= MAX_LIVE_REASONING_ROWS
        ? value
        : undefined;
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

export function loadTuiSidebarWidth(
    path = tuiThemePreferencePath(),
): number | undefined {
    return loadTuiClientPreferences(path).sidebar_width;
}

export function saveTuiSidebarWidth(
    columns: number,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        sidebar_width: columns,
    }, path);
}

export function loadTuiWorkspaceSidebarWidth(
    path = tuiThemePreferencePath(),
): number | undefined {
    return loadTuiClientPreferences(path).workspace_sidebar_width;
}

export function saveTuiWorkspaceSidebarWidth(
    columns: number,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        workspace_sidebar_width: columns,
    }, path);
}

export function loadTuiSharedSessionGroups(
    path = tuiThemePreferencePath(),
): readonly (readonly [string, string])[] {
    return loadTuiClientPreferences(path).shared_session_groups ?? [];
}

export function saveTuiSharedSessionGroups(
    groups: readonly (readonly [string, string])[],
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        shared_session_groups: groups,
    }, path);
}

export function loadTuiPinnedSessionIds(
    path = tuiThemePreferencePath(),
): readonly string[] {
    return loadTuiClientPreferences(path).pinned_session_ids ?? [];
}

export function saveTuiPinnedSessionIds(
    ids: readonly string[],
    path = tuiThemePreferencePath(),
): void {
    const { pinned_session_ids: _previous, ...rest } = loadTuiClientPreferences(
        path,
    );
    saveTuiClientPreferences({
        ...rest,
        ...(ids.length === 0 ? {} : { pinned_session_ids: ids }),
    }, path);
}

export function loadTuiPersistedAgentPane(
    mainAgentId: string,
    path = tuiThemePreferencePath(),
): TuiPersistedAgentPane | undefined {
    const saved = loadTuiClientPreferences(path).persisted_agent_panes
        ?.find((pane) => pane.main_agent_id === mainAgentId);
    return saved === undefined
        ? undefined
        : {
            mainAgentId: saved.main_agent_id,
            sidebarAgentId: saved.sidebar_agent_id,
            owner: saved.owner,
            ...(saved.mention === undefined ? {} : { mention: saved.mention }),
            ...(saved.status_label === undefined
                ? {}
                : { statusLabel: saved.status_label }),
        };
}

export function saveTuiPersistedAgentPane(
    mainAgentId: string,
    pane: TuiPersistedAgentPane | undefined,
    path = tuiThemePreferencePath(),
): void {
    const preferences = loadTuiClientPreferences(path);
    const panes = (preferences.persisted_agent_panes ?? [])
        .filter((saved) => saved.main_agent_id !== mainAgentId);
    const { persisted_agent_panes: _previous, ...withoutPanes } = preferences;
    saveTuiClientPreferences({
        ...withoutPanes,
        ...(pane === undefined && panes.length === 0
            ? {}
            : {
                persisted_agent_panes: [
                    ...panes,
                    ...(pane === undefined ? [] : [{
                        main_agent_id: pane.mainAgentId,
                        sidebar_agent_id: pane.sidebarAgentId,
                        owner: pane.owner,
                        ...(pane.mention === undefined
                            ? {}
                            : { mention: pane.mention }),
                        ...(pane.statusLabel === undefined
                            ? {}
                            : { status_label: pane.statusLabel }),
                    }]),
                ],
            }),
    }, path);
}

export function loadTuiKeybindingOverlay(
    path = tuiThemePreferencePath(),
): Readonly<Record<string, readonly string[]>> {
    return loadTuiClientPreferences(path).keybindings ?? {};
}

export function loadTuiExtensionPreference(
    extensionId: string,
    key: string,
    path = tuiThemePreferencePath(),
): JsonValue | undefined {
    return loadTuiClientPreferences(path).extensions?.[extensionId]?.[key];
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

function parsePinnedSessionIds(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0
    );
}

function loadTuiClientPreferences(path: string): TuiClientPreferences {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (typeof value === "object" && value !== null) {
            const theme = Reflect.get(value, "theme");
            const animation = Reflect.get(value, "animation");
            const storedLevel = Reflect.get(value, "animation_level");
            const level: TuiAnimationLevel = isTuiAnimationLevel(storedLevel)
                ? storedLevel
                : DEFAULT_ANIMATION_LEVEL;
            const recentSessionId = Reflect.get(value, "recent_session_id");
            const interval = boundedInteger(
                Reflect.get(value, "animation_interval_ms"),
                32,
                2_000,
            );
            const width = boundedInteger(
                Reflect.get(value, "animation_width"),
                2,
                15,
            );
            const sidebarWidth = boundedInteger(
                Reflect.get(value, "sidebar_width"),
                20,
                400,
            );
            const workspaceSidebarWidth = boundedInteger(
                Reflect.get(value, "workspace_sidebar_width"),
                20,
                400,
            );
            const keybindings = parseKeybindingOverlay(
                Reflect.get(value, "keybindings"),
            );
            const extensions = parseExtensionPreferences(
                Reflect.get(value, "extensions"),
            );
            const sharedSessionGroups = parseSharedSessionGroups(
                Reflect.get(value, "shared_session_groups"),
            );
            const persistedAgentPanes = parsePersistedAgentPanes(
                Reflect.get(value, "persisted_agent_panes"),
            );
            const pinnedSessionIds = parsePinnedSessionIds(
                Reflect.get(value, "pinned_session_ids"),
            );
            const liveReasoningRows = parseLiveReasoningRows(
                Reflect.get(value, "live_reasoning_rows"),
            );
            return {
                ...(Reflect.get(value, "model_picker") === undefined ? {} : { model_picker: parseModelPickerPreferences(Reflect.get(value, "model_picker")) }),
                theme: isTuiThemeName(theme) ? theme : "default",
                animation: isTuiActivityAnimation(animation)
                    ? animation
                    : "shimmer",
                animation_level: level,
                ...(liveReasoningRows === undefined
                    ? {}
                    : { live_reasoning_rows: liveReasoningRows }),
                ...(typeof recentSessionId === "string"
                        && recentSessionId.length > 0
                    ? { recent_session_id: recentSessionId }
                    : {}),
                ...(interval === undefined
                    ? {}
                    : { animation_interval_ms: interval }),
                ...(width === undefined ? {} : { animation_width: width }),
                ...(sidebarWidth === undefined
                    ? {}
                    : { sidebar_width: sidebarWidth }),
                ...(workspaceSidebarWidth === undefined
                    ? {}
                    : { workspace_sidebar_width: workspaceSidebarWidth }),
                ...(keybindings === undefined ? {} : { keybindings }),
                ...(extensions === undefined ? {} : { extensions }),
                ...(sharedSessionGroups.length === 0
                    ? {}
                    : { shared_session_groups: sharedSessionGroups }),
                ...(persistedAgentPanes.length === 0
                    ? {}
                    : { persisted_agent_panes: persistedAgentPanes }),
                ...(pinnedSessionIds.length === 0
                    ? {}
                    : { pinned_session_ids: pinnedSessionIds }),
            };
        }
    } catch {
        // Missing or malformed client preferences must not prevent startup.
    }
    return { theme: "default", animation: "shimmer", animation_level: DEFAULT_ANIMATION_LEVEL };
}

function parsePersistedAgentPanes(value: unknown): readonly DiskPersistedAgentPane[] {
    if (!Array.isArray(value)) return [];
    const usedMainIds = new Set<string>();
    return value.flatMap((candidate) => {
        const pane = parsePersistedAgentPane(candidate);
        if (pane === undefined || usedMainIds.has(pane.main_agent_id)) return [];
        usedMainIds.add(pane.main_agent_id);
        return [pane];
    });
}

function parsePersistedAgentPane(value: unknown): DiskPersistedAgentPane | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const mainAgentId = Reflect.get(value, "main_agent_id");
    const sidebarAgentId = Reflect.get(value, "sidebar_agent_id");
    const owner = Reflect.get(value, "owner");
    const mention = Reflect.get(value, "mention");
    const statusLabel = Reflect.get(value, "status_label");
    if (
        typeof mainAgentId !== "string" || mainAgentId.length === 0
        || typeof sidebarAgentId !== "string" || sidebarAgentId.length === 0
        || mainAgentId === sidebarAgentId
        || typeof owner !== "string" || owner.length === 0
        || (mention !== undefined
            && (typeof mention !== "string" || mention.length === 0))
        || (statusLabel !== undefined
            && (typeof statusLabel !== "string" || statusLabel.length === 0))
    ) {
        return undefined;
    }
    return {
        main_agent_id: mainAgentId,
        sidebar_agent_id: sidebarAgentId,
        owner,
        ...(mention === undefined ? {} : { mention }),
        ...(statusLabel === undefined ? {} : { status_label: statusLabel }),
    };
}

function parseSharedSessionGroups(
    value: unknown,
): readonly (readonly [string, string])[] {
    if (!Array.isArray(value)) return [];
    const used = new Set<string>();
    return value.flatMap((candidate) => {
        if (
            !Array.isArray(candidate)
            || candidate.length !== 2
            || candidate.some((id) => typeof id !== "string" || id.length === 0)
        ) return [];
        const [first, second] = candidate as [string, string];
        if (first === second || used.has(first) || used.has(second)) return [];
        used.add(first);
        used.add(second);
        return [[first, second] as const];
    });
}

function parseKeybindingOverlay(
    value: unknown,
): Readonly<Record<string, readonly string[]>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const overlay: Record<string, readonly string[]> = {};
    for (const [id, chords] of Object.entries(value)) {
        if (
            Array.isArray(chords)
            && chords.every((chord) => typeof chord === "string")
        ) {
            overlay[id] = chords as readonly string[];
        } else {
            overlay[id] = [String(chords)];
        }
    }
    return Object.keys(overlay).length === 0 ? undefined : overlay;
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

export function isTuiActivityAnimation(
    value: unknown,
): value is TuiActivityAnimation {
    return value === "conveyor"
        || value === "symmetric_wave"
        || value === "shimmer"
        || value === "braille"
        || value === "off";
}
