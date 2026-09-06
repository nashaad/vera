
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    EMPTY_POOL_FILE,
    issueSeverity,
    isCuratedPoolEntry,
    NO_PRESERVED_POOL_FIELDS,
    type LearnedFact,
    type LearnedFacts,
    type ParsedPoolFile,
    type PoolFile,
    type PoolFileIssue,
    type PoolFileDefaults,
    type PoolFileModel,
    type PreservedPoolFields,
    parsePoolFileText,
} from "./pool-file.ts";
import { userPoolFilePath } from "./pool-file-loader.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export interface PoolStoreOptions {
    readonly path?: string;
}

export class PoolFileWriteRefusedError extends Error {
    readonly path: string;
    readonly issues: readonly PoolFileIssue[];

    constructor(path: string, issues: readonly PoolFileIssue[]) {
        super(
            `${path} did not parse cleanly, so it was left untouched: `
                + issues
                    .map((issue) =>
                        issue.path === ""
                            ? issue.message
                            : `${issue.path}: ${issue.message}`
                    )
                    .join("; "),
        );
        this.name = "PoolFileWriteRefusedError";
        this.path = path;
        this.issues = issues;
    }
}

export function readUserPoolFile(options: PoolStoreOptions = {}): PoolFile {
    return readForUpdate(options.path ?? userPoolFilePath()).file;
}

function readForUpdate(path: string): ParsedPoolFile {
    let text: string;
    try {
        text = readRegularFileTextSync(path);
    } catch {
        return {
            file: EMPTY_POOL_FILE,
            issues: [],
            preserved: NO_PRESERVED_POOL_FIELDS,
        };
    }
    return parsePoolFileText(text);
}

export function addPoolModel(
    modelId: string,
    declared: PoolFileModel = {},
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const existing = file.models[modelId];
        const models: Record<string, PoolFileModel> = {
            [modelId]: {
                ...declared,
                ...(existing?.learned === undefined
                    ? {}
                    : { learned: existing.learned }),
            },
        };
        for (const [id, entry] of Object.entries(file.models)) {
            if (id !== modelId) {
                models[id] = entry;
            }
        }
        return { ...file, models };
    });
}

/** Sets or clears the name on an entry that is already pooled. Separate from `addPoolModel`, which replaces the declared half wholesale and moves the entry to the front: a rename. */
export function namePoolModel(
    modelId: string,
    name: string | undefined,
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const existing = file.models[modelId];
        if (existing === undefined) {
            return file;
        }
        const { name: previous, ...rest } = existing;
        return {
            ...file,
            models: {
                ...file.models,
                [modelId]: name === undefined ? rest : { ...rest, name },
            },
        };
    });
}

export function movePoolModel(
    modelId: string,
    delta: number,
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const ids = Object.keys(file.models);
        const from = ids.indexOf(modelId);
        if (from === -1 || delta === 0) {
            return file;
        }
        const to = Math.min(ids.length - 1, Math.max(0, from + delta));
        if (to === from) {
            return file;
        }
        ids.splice(to, 0, ...ids.splice(from, 1));
        const models: Record<string, PoolFileModel> = {};
        for (const id of ids) {
            const entry = file.models[id];
            if (entry !== undefined) {
                models[id] = entry;
            }
        }
        return { ...file, models };
    });
}

export function removePoolModel(
    modelId: string,
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const models = { ...file.models };
        delete models[modelId];
        return { ...file, models };
    });
}

export function setPoolMembership(
    modelIds: readonly string[], kept: boolean, options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const models = { ...file.models };
        for (const id of modelIds) models[id] = { ...models[id], added: kept };
        return { ...file, models };
    });
}

export function renameModelDisplay(modelId: string, displayName: string, options: PoolStoreOptions = {}): PoolFile {
    return updatePoolFile(options, (file) => {
        const entry = file.models[modelId] ?? { added: false };
        return { ...file, models: { ...file.models, [modelId]: { ...entry, displayName } } };
    });
}

export function recordModelVerification(modelId: string, facts: LearnedFacts, options: PoolStoreOptions = {}): PoolFile {
    return updatePoolFile(options, (file) => {
        const entry = file.models[modelId];
        return { ...file, models: { ...file.models, [modelId]: {
            ...entry, added: entry !== undefined && isCuratedPoolEntry(entry),
            learned: { ...entry?.learned, ...facts },
        } } };
    });
}

export function recordLearned(
    modelId: string,
    facts: LearnedFacts,
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const existing = file.models[modelId] ?? {};
        return {
            ...file,
            models: {
                ...file.models,
                [modelId]: {
                    ...existing,
                    learned: { ...existing.learned, ...facts },
                },
            },
        };
    });
}

export function clearLearned(
    modelId: string,
    keys?: readonly string[],
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => {
        const existing = file.models[modelId];
        if (existing?.learned === undefined) {
            return file;
        }
        const learned: Record<string, LearnedFact> = { ...existing.learned };
        for (const key of keys ?? Object.keys(learned)) {
            delete learned[key];
        }
        const { learned: _dropped, ...rest } = existing;
        return {
            ...file,
            models: {
                ...file.models,
                [modelId]: Object.keys(learned).length === 0
                    ? rest
                    : { ...rest, learned },
            },
        };
    });
}

export function updateDefaults(
    defaults: PoolFileDefaults,
    options: PoolStoreOptions = {},
): PoolFile {
    return updatePoolFile(options, (file) => ({
        ...file,
        defaults: { ...file.defaults, ...defaults },
    }));
}

function updatePoolFile(
    options: PoolStoreOptions,
    update: (file: PoolFile) => PoolFile,
): PoolFile {
    const path = options.path ?? userPoolFilePath();
    const current = readForUpdate(path);
    const errors = current.issues.filter(
        (issue) => issueSeverity(issue) === "error",
    );
    if (errors.length > 0) {
        throw new PoolFileWriteRefusedError(path, errors);
    }
    const updated = update(current.file);
    const directory = dirname(path);
    const temporaryPath = join(directory, `.pool-${randomUUID()}.tmp`);

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        temporaryPath,
        `${JSON.stringify(serialize(updated, current.preserved), null, 2)}\n`,
        { mode: 0o600 },
    );
    renameSync(temporaryPath, path);
    return updated;
}

function serialize(
    file: PoolFile,
    preserved: PreservedPoolFields,
): Record<string, unknown> {
    const models: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(file.models)) {
        models[id] = { ...preserved.models[id], ...entry };
    }
    return {
        ...preserved.root,
        defaults: { ...preserved.defaults, ...file.defaults },
        models,
    };
}
