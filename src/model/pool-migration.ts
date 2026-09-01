
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function defaultConfigPath(): string {
    return join(veraProfileDirectory(), "config.json");
}

export function migrateConfigPool(
    options: PoolMigrationOptions = {},
): PoolMigrationOutcome {
    const configPath = options.configPath ?? defaultConfigPath();
    const poolPath = options.poolPath ?? userPoolFilePath();
    if (existsSync(poolPath)) {
        return { migrated: [] };
    }

    const config = readConfig(configPath);
    if (config === undefined) {
        return { migrated: [] };
    }
    const entries = legacyEntries(config);
    if (entries.length === 0) {
        return { migrated: [] };
    }

    const migrated: string[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as LegacyEntry;
        addPoolModel(entry.id, entry.declared, { path: poolPath });
        if (Object.keys(entry.learned).length > 0) {
            recordLearned(entry.id, entry.learned, { path: poolPath });
        }
        migrated.unshift(entry.id);
    }

    return {
        migrated,
        notice: `Moved ${migrated.length} pooled `
            + `${migrated.length === 1 ? "model" : "models"} from ${configPath}`
            + ` to ${poolPath}. The old entries were left in place.`,
    };
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
