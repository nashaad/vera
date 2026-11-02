
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isEffortLevel } from "./effort-ladder.ts";
import {
    PROBE_LEARNED_KEY,
    effortLearnedKey,
    type LearnedFact,
    type LearnedFacts,
    type PoolFileModel,
} from "./pool-file.ts";
import { userPoolFilePath } from "./pool-file-loader.ts";
import { addPoolModel, recordLearned } from "./pool-file-store.ts";
import { veraProfileDirectory } from "../profile-paths.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export interface PoolMigrationOptions {
    readonly configPath?: string;
    readonly poolPath?: string;
}

export interface PoolMigrationOutcome {
    readonly migrated: readonly string[];
    readonly notice?: string;
}

const LEGACY_DEEPSEEK_FLASH_ID = "deepseek/deepseek-v4-flash";
const DEEPSEEK_FLASH_ID = "deepseek/deepseek-flash";

export function defaultConfigPath(): string {
    return join(veraProfileDirectory(), "config.json");
}

export function migrateConfigPool(
    options: PoolMigrationOptions = {},
): PoolMigrationOutcome {
    const configPath = options.configPath ?? defaultConfigPath();
    const poolPath = options.poolPath ?? userPoolFilePath();
    const configModels = migrateLegacyConfigPool(configPath, poolPath);
    const migrated = [...configModels];
    const renamedDeepSeekFlash = migrateDeepSeekFlashPoolId(poolPath);
    const updatedDeepSeekConfig = migrateDeepSeekFlashConfigId(configPath);
    if (renamedDeepSeekFlash || updatedDeepSeekConfig) {
        if (!migrated.includes(DEEPSEEK_FLASH_ID)) {
            migrated.push(DEEPSEEK_FLASH_ID);
        }
    }
    if (migrated.length === 0) {
        return { migrated };
    }

    const notices: string[] = [];
    if (configModels.length > 0) {
        notices.push(
            `Moved ${configModels.length} pooled `
            + `${configModels.length === 1 ? "model" : "models"} from ${configPath}`
            + ` to ${poolPath}. The old entries were left in place.`,
        );
    }
    if (renamedDeepSeekFlash || updatedDeepSeekConfig) {
        notices.push(`Updated ${LEGACY_DEEPSEEK_FLASH_ID} to ${DEEPSEEK_FLASH_ID}.`);
    }
    return { migrated, notice: notices.join(" ") };
}

function migrateLegacyConfigPool(configPath: string, poolPath: string): string[] {
    if (existsSync(poolPath)) {
        return [];
    }
    const config = readConfig(configPath);
    const entries = config === undefined ? [] : legacyEntries(config);
    const migrated: string[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as LegacyEntry;
        addPoolModel(entry.id, entry.declared, { path: poolPath });
        if (Object.keys(entry.learned).length > 0) {
            recordLearned(entry.id, entry.learned, { path: poolPath });
        }
        migrated.unshift(entry.id);
    }
    return migrated;
}

function migrateDeepSeekFlashPoolId(path: string): boolean {
    const pool = readConfig(path);
    const models = recordValue(pool?.models);
    const legacy = recordValue(models?.[LEGACY_DEEPSEEK_FLASH_ID]);
    if (pool === undefined || models === undefined || legacy === undefined) {
        return false;
    }
    const current = recordValue(models[DEEPSEEK_FLASH_ID]);
    const renamed: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(models)) {
        if (id === LEGACY_DEEPSEEK_FLASH_ID) {
            if (current === undefined) {
                renamed[DEEPSEEK_FLASH_ID] = updateModelReferences(legacy);
            }
            continue;
        }
        if (id === DEEPSEEK_FLASH_ID && current !== undefined) {
            renamed[id] = updateModelReferences(mergeModelEntries(legacy, current));
            continue;
        }
        renamed[id] = updateModelReferences(value);
    }
    const defaults = recordValue(pool.defaults);
    const updatedDefaults = defaults?.subagent === LEGACY_DEEPSEEK_FLASH_ID
        ? { ...defaults, subagent: DEEPSEEK_FLASH_ID }
        : defaults;
    const updated = {
        ...pool,
        ...(updatedDefaults === undefined ? {} : { defaults: updatedDefaults }),
        models: renamed,
    };
    writeJsonAtomically(path, updated, "pool");
    return true;
}

function migrateDeepSeekFlashConfigId(path: string): boolean {
    const config = readConfig(path);
    if (config === undefined) {
        return false;
    }
    const replaced = replaceDeepSeekFlashIds(config);
    if (!replaced.changed) {
        return false;
    }
    writeJsonAtomically(path, replaced.value, "config");
    return true;
}

interface ReplacedValue {
    readonly value: unknown;
    readonly changed: boolean;
}

function replaceDeepSeekFlashIds(value: unknown): ReplacedValue {
    if (typeof value === "string") {
        const canonical = canonicalDeepSeekFlashId(value);
        return { value: canonical, changed: canonical !== value };
    }
    if (Array.isArray(value)) {
        const items = value.map(replaceDeepSeekFlashIds);
        return {
            value: items.map((item) => item.value),
            changed: items.some((item) => item.changed),
        };
    }
    const record = recordValue(value);
    if (record === undefined) {
        return { value, changed: false };
    }
    const entries = Object.entries(record).map(([key, item]) => {
        const canonicalKey = canonicalDeepSeekFlashId(key);
        const replaced = replaceDeepSeekFlashIds(item);
        return {
            key: canonicalKey,
            value: replaced.value,
            changed: replaced.changed || canonicalKey !== key,
            shadowed: canonicalKey !== key
                && Object.hasOwn(record, canonicalKey),
        };
    });
    return {
        value: Object.fromEntries(entries
            .filter((entry) => !entry.shadowed)
            .map((entry) => [entry.key, entry.value])),
        changed: entries.some((entry) => entry.changed),
    };
}

function canonicalDeepSeekFlashId(value: string): string {
    if (value === "deepseek-v4-flash") {
        return "deepseek-flash";
    }
    return value === LEGACY_DEEPSEEK_FLASH_ID ? DEEPSEEK_FLASH_ID : value;
}

function writeJsonAtomically(path: string, value: unknown, name: string): void {
    const temporaryPath = join(dirname(path), `.${name}-migration-${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
}

function mergeModelEntries(
    legacy: Record<string, unknown>,
    current: Record<string, unknown>,
): Record<string, unknown> {
    const legacyLearned = recordValue(legacy.learned);
    const currentLearned = recordValue(current.learned);
    return {
        ...legacy,
        ...current,
        ...(legacyLearned === undefined && currentLearned === undefined
            ? {}
            : { learned: { ...legacyLearned, ...currentLearned } }),
    };
}

function updateModelReferences(value: unknown): unknown {
    const model = recordValue(value);
    if (model === undefined || !Array.isArray(model.fallback)) {
        return value;
    }
    const fallback = [...new Set(model.fallback.map((id) => (
        id === LEGACY_DEEPSEEK_FLASH_ID ? DEEPSEEK_FLASH_ID : id
    )))];
    return { ...model, fallback };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

interface LegacyEntry {
    readonly id: string;
    readonly declared: PoolFileModel;
    readonly learned: LearnedFacts;
}

function readConfig(path: string): Record<string, unknown> | undefined {
    let text: string;
    try {
        text = readRegularFileTextSync(path);
    } catch {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null
                && !Array.isArray(value)
            ? value as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}

function legacyEntries(
    config: Record<string, unknown>,
): readonly LegacyEntry[] {
    if (!Array.isArray(config.pool)) {
        return [];
    }
    return config.pool.flatMap((value) => {
        const entry = poolEntry(value);
        return entry === undefined ? [] : [entry];
    });
}

function poolEntry(value: unknown): LegacyEntry | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const provider = record.provider;
    const model = record.model;
    if (
        typeof provider !== "string" || provider.length === 0
        || typeof model !== "string" || model.length === 0
    ) {
        return undefined;
    }
    return {
        id: `${provider}/${model}`,
        declared: {},
        learned: learnedFromVerification(record.verification),
    };
}

function learnedFromVerification(value: unknown): LearnedFacts {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    const record = value as Record<string, unknown>;
    const seen = typeof record.verified_at === "string"
        ? record.verified_at
        : undefined;
    if (seen === undefined || record.needs_reverify === true) {
        return {};
    }
    const checked = record.checked === "user_key" || record.checked === "vera"
        ? record.checked
        : undefined;
    const base = (extra: Record<string, string>): LearnedFact => ({
        ok: true,
        seen,
        ...extra,
        ...(checked === undefined ? {} : { checked }),
    });

    const learned: Record<string, LearnedFact> = {};
    if (typeof record.response_model === "string") {
        learned[PROBE_LEARNED_KEY] = base({ wire: record.response_model });
    }
    if (!Array.isArray(record.levels)) {
        return learned;
    }
    for (const level of record.levels) {
        if (typeof level !== "object" || level === null) {
            continue;
        }
        const item = level as Record<string, unknown>;
        const wire = item.provider_effort;
        const rung = item.vera_effort === "none" ? "off" : item.vera_effort;
        if (!isEffortLevel(rung) || typeof wire !== "string") {
            continue;
        }
        learned[effortLearnedKey(rung)] = base({ wire });
    }
    return learned;
}
