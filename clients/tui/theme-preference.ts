import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { JsonValue } from "../../src/sdk/hooks.ts";
import type { TuiThemeName } from "./theme.ts";
import type { TuiActivityAnimation } from "./activity-pulse.ts";
import {
    quickslotsForDisk,
    parseQuickslots,
    type DiskQuickslots,
    type Quickslots,
} from "./quickslots.ts";
import { veraProfileDirectory } from "../../src/profile-paths.ts";

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
    readonly sidebar_width?: number;
    readonly shared_session_groups?: readonly (readonly [string, string])[];
    readonly persisted_agent_panes?: readonly DiskPersistedAgentPane[];
    // Spelled as it was when quickslots were called presets. Respelling the key
    // would leave every already-saved slot unreadable.
    readonly model_presets?: DiskQuickslots;
    // Binding id to chords. Ids only: a block that could name actions would be
    // a macro language, and a macro language is where blind cycling comes back.
    readonly keybindings?: Readonly<Record<string, readonly string[]>>;
    readonly extensions?: Readonly<
        Record<string, Readonly<Record<string, JsonValue>>>
    >;
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

export function loadTuiQuickslots(
    path = tuiThemePreferencePath(),
): Quickslots {
    return parseQuickslots(loadTuiClientPreferences(path).model_presets);
}

export function saveTuiQuickslots(
    slots: Quickslots,
    path = tuiThemePreferencePath(),
): void {
    saveTuiClientPreferences({
        ...loadTuiClientPreferences(path),
        model_presets: quickslotsForDisk(slots),
    }, path);
}

/**
 * The user's key overrides, unvalidated.
 *
 * Validation belongs to the merge in `keybindings.ts`, which is the only place
 * that knows which ids exist and which chords are already claimed. Reading the
 * block here only asserts its shape: an object of string lists.
 */
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
    const preferences = loadTuiClientPreferences(path);
    const value = preferences.extensions?.[extensionId]?.[key];
    if (value !== undefined) {
        return value;
    }
    // The bundled extension keeps quickslots saved by the former built-in
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
                32,
                2_000,
            );
            const width = boundedInteger(
                Reflect.get(value, "animation_width"),
                2,
                15,
            );
            // Absent quickslots stay absent rather than becoming four nulls, so
            // saving an unrelated preference does not grow the file with a
            // block the user never asked for.
            const sidebarWidth = boundedInteger(
                Reflect.get(value, "sidebar_width"),
                20,
                400,
            );
            const quickslots = Reflect.get(value, "model_presets");
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
                ...(sidebarWidth === undefined
                    ? {}
                    : { sidebar_width: sidebarWidth }),
                ...(Array.isArray(quickslots)
                    ? {
                        model_presets: quickslotsForDisk(
                            parseQuickslots(quickslots),
                        ),
                    }
                    : {}),
                ...(keybindings === undefined ? {} : { keybindings }),
                ...(extensions === undefined ? {} : { extensions }),
                ...(sharedSessionGroups.length === 0
                    ? {}
                    : { shared_session_groups: sharedSessionGroups }),
                ...(persistedAgentPanes.length === 0
                    ? {}
                    : { persisted_agent_panes: persistedAgentPanes }),
            };
        }
    } catch {
        // Missing or malformed client preferences must not prevent startup.
    }
    return { theme: "default", animation: "conveyor" };
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

/**
 * The keybindings block as written, minus anything that is not a list of
 * strings. A malformed value is dropped here and named by the merge, which is
 * what turns a typo into a banner line rather than a crash.
 */
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
            // Kept, so the merge can say which id was wrong rather than
            // silently behaving as though it had never been written.
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

export function isTuiThemeName(value: unknown): value is TuiThemeName {
    return value === "default"
        || value === "system"
        || value === "muted-blue"
        || value === "orng"
        || value === "palenight"
        || value === "synthwave"
        || value === "nightowl"
        || value === "github"
        || value === "midnight-blue"
        || value === "midnight-blue-ii";
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
