import { basename, resolve } from "node:path";

import type { VeraConfig } from "../config.ts";
import { hostExtensionConfigs } from "../extensions/host-set.ts";
import { extensionServesHost, loadExtensionManifest } from "../extensions/manifest.ts";
import { fileReadStamp } from "../store/read-cache.ts";

/** How a config edit changes one extension against what this host loaded at startup. */
export interface ExtensionConfigChange {
    readonly operation: "enable" | "disable" | "update";
    readonly id: string;
    /** True when the running host would load a different extension code after the edit. */
    readonly needsRestart: boolean;
}

export const EXTENSION_CONFIG_NOTICE_KEY = "extensions_config";

export interface ExtensionConfigWatch {
    /** The current mismatch between config and the host's startup extension set. */
    drift(): readonly ExtensionConfigChange[];
    start(onChange: (changes: readonly ExtensionConfigChange[]) => void): void;
    stop(): void;
}

type ExtensionConfigFields = Pick<
    VeraConfig,
    "disabled_included_extensions" | "extensions"
>;

export interface ExtensionConfigEntry {
    readonly id: string;
    readonly path: string;
    readonly enabled: boolean;
    readonly servesHost: boolean;
}

let runningWatches = 0;

// The host reads extensions once at startup, so a config edit changes the running
// host only after a restart. This watch reports the drift; it never reloads extensions.
export function createExtensionConfigWatch(options: {
    readonly configPath: string;
    readonly config: ExtensionConfigFields;
    readonly currentConfig: () => ExtensionConfigFields;
    readonly intervalMs?: number;
}): ExtensionConfigWatch {
    const startup = extensionConfigEntries(options.config);
    // A worker can start after config.json changed while the host kept its startup set.
    const observedAtStart = readEntries(options.currentConfig) ?? startup;
    let observed = observedAtStart;
    let drift = driftAgainstStartup(startup, observedAtStart);
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastStamp = fileReadStamp(options.configPath);

    const tick = (onChange: (changes: readonly ExtensionConfigChange[]) => void): void => {
        const before = fileReadStamp(options.configPath);
        // An unchanged stamp must not read or parse the config.
        if (before === undefined || before === lastStamp) return;
        let next: Map<string, ExtensionConfigEntry>;
        try {
            next = extensionConfigEntries(options.currentConfig());
        } catch {
            return;
        }
        // A save still in flight leaves the stamp different on the next tick.
        if (fileReadStamp(options.configPath) !== before) return;
        lastStamp = before;
        const changes = diffExtensionConfigEntries(observed, next, startup);
        drift = driftAgainstStartup(startup, next);
        observed = next;
        if (changes.length > 0) onChange(changes);
    };

    return {
        drift: () => [...drift.values()],
        start(onChange) {
            if (timer !== undefined) return;
            timer = setInterval(
                () => tick(onChange),
                options.intervalMs ?? 1_000,
            );
            timer.unref?.();
            runningWatches += 1;
        },
        stop() {
            if (timer === undefined) return;
            clearInterval(timer);
            timer = undefined;
            runningWatches -= 1;
        },
    };
}

/** Test hook: proves a closed host leaves no config timer behind. */
export function activeExtensionConfigWatches(): number {
    return runningWatches;
}

function driftAgainstStartup(
    startup: ReadonlyMap<string, ExtensionConfigEntry>,
    now: ReadonlyMap<string, ExtensionConfigEntry>,
): Map<string, ExtensionConfigChange> {
    return new Map(
        diffExtensionConfigEntries(startup, now, startup)
            .filter((change) => change.needsRestart)
            .map((change) => [change.id, change]),
    );
}

function readEntries(
    currentConfig: () => ExtensionConfigFields,
): Map<string, ExtensionConfigEntry> | undefined {
    try {
        return extensionConfigEntries(currentConfig());
    } catch {
        return undefined;
    }
}

export function extensionConfigNoticeText(change: ExtensionConfigChange): string {
    const mutation = change.operation === "enable"
        ? `Enabled ${change.id}.`
        : change.operation === "disable"
        ? `Disabled ${change.id}.`
        : `Updated ${change.id}.`;
    if (!change.needsRestart) return mutation;
    const action = change.operation === "enable"
        ? "load"
        : change.operation === "disable"
        ? "unload"
        : "apply";
    return `${mutation} Use Reconnect host (Ctrl+P) to ${action} it.`;
}

export function diffExtensionConfigEntries(
    before: ReadonlyMap<string, ExtensionConfigEntry>,
    after: ReadonlyMap<string, ExtensionConfigEntry>,
    startup: ReadonlyMap<string, ExtensionConfigEntry>,
): readonly ExtensionConfigChange[] {
    const changes: ExtensionConfigChange[] = [];
    for (const [id, next] of after) {
        const previous = before.get(id);
        if (previous === undefined) {
            if (!next.enabled) continue;
            changes.push({
                operation: "enable",
                id,
                needsRestart: restartRequired(id, startup, after),
            });
            continue;
        }
        if (!previous.enabled && !next.enabled) continue;
        if (previous.path !== next.path) {
            changes.push({ operation: "update", id, needsRestart: restartRequired(id, startup, after) });
            continue;
        }
        if (previous.enabled !== next.enabled) {
            changes.push({
                operation: next.enabled ? "enable" : "disable",
                id,
                needsRestart: restartRequired(id, startup, after),
            });
        }
    }
    for (const [id, previous] of before) {
        if (after.has(id) || !previous.enabled) continue;
        changes.push({
            operation: "disable",
            id,
            needsRestart: restartRequired(id, startup, after),
        });
    }
    return changes.sort((left, right) => left.id.localeCompare(right.id));
}

function restartRequired(
    id: string,
    startup: ReadonlyMap<string, ExtensionConfigEntry>,
    now: ReadonlyMap<string, ExtensionConfigEntry>,
): boolean {
    const before = startup.get(id);
    const after = now.get(id);
    if (before === undefined && after === undefined) return false;
    if (before === undefined) return after?.enabled === true && after.servesHost;
    if (after === undefined) return before.enabled && before.servesHost;
    if (!before.enabled && !after.enabled) return false;
    if (before.path === after.path && before.enabled === after.enabled) return false;
    return before.servesHost || after.servesHost;
}

export function extensionConfigEntries(
    config: ExtensionConfigFields,
): Map<string, ExtensionConfigEntry> {
    const entries = new Map<string, ExtensionConfigEntry>();
    for (const configured of hostExtensionConfigs(config)) {
        let id: string;
        let path = resolve(configured.path);
        let servesHost = true;
        try {
            const loaded = loadExtensionManifest(configured.path);
            id = loaded.manifest.id;
            path = loaded.directory;
            servesHost = extensionServesHost(loaded.manifest);
        } catch {
            // A manifest that does not load still changes the config set; the host reports it.
            id = basename(path);
        }
        entries.set(id, {
            id,
            path,
            enabled: configured.enabled,
            servesHost,
        });
    }
    return entries;
}
