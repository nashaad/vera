/**
 * Writing the declarative pool file.
 *
 * Every write lands in the user-scope file. The project-scope file is a
 * hand-maintained overlay a repository can commit, so a machine write into it
 * would put one developer's probe results in everyone else's checkout.
 *
 * Declared and learned are kept apart at the API, not by convention:
 * `addPoolModel` writes only declared fields, `recordLearned` writes only
 * learned keys, and neither reaches into the other's half of the entry.
 * Entry order is admission order, newest first, and using a model does not
 * move it.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    EMPTY_POOL_FILE,
    issueSeverity,
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
    /** Overrides `~/.vera/pool.json`. */
    readonly path?: string;
}

/**
 * Thrown instead of writing when a value in the file on disk was rejected.
 *
 * A write serializes the parsed file back over the user's text, so a file with
 * a rejected value would be written back as whatever survived: in the worst
 * case an empty pool over a hand-written one. Refusing keeps the user's text
 * and leaves the failed write to be reported.
 *
 * Warnings do not refuse. The only warning is an unknown field, which is
 * carried through the write verbatim, so nothing of the user's is at risk.
 */
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

/**
 * A missing file is an empty pool with no issues: there is nothing to preserve
 * and the first write creates it. A file that exists but does not parse keeps
 * its issues, which is what blocks the write.
 */
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

/**
 * Adds or updates the declared half of an entry. An entry with no declared
 * fields at all is still meaningful: it says the user put this model in the
 * pool, which is the fact `pool_add` records before any probe has run.
 */
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

/**
 * Sets or clears the name on an entry that is already pooled.
 *
 * Separate from `addPoolModel`, which replaces the declared half wholesale
 * and moves the entry to the front: a rename changes one field and must not
 * reorder the pool, because file order is what the failsafe rung walks.
 *
 * The caller checks `poolNameRefusal` first. This refuses only the case that
 * the check cannot see, an entry that is not in the file at all.
 */
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

/**
 * Moves an entry within the pool's declared order, by `delta` places.
 *
 * File order is the mechanism rather than a field, because it already is:
 * admission writes to the front, and the failsafe rung walks the file in the
 * order it finds. This rewrites the key order and nothing else, so an entry's
 * declared and learned halves both travel with it untouched.
 *
 * A move past either end clamps rather than wrapping. The pool is a ranked
 * shortlist, and wrapping would send the user's first preference to last on a
 * keypress they meant as "already at the top".
 */
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

/**
 * Merges machine-concluded facts into an entry, key by key, so a fresh
 * rejection does not erase what an earlier probe established about other
 * levels. Creates the entry when the model is not in the pool yet: learning
 * something about a model is not the same as the user admitting it, but the
 * fact still needs somewhere to live.
 */
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

/**
 * Drops learned keys, which is how a model is sent back for reverification:
 * the old evidence is no longer trusted, so it is removed rather than being
 * flagged and left in place to be read by something that misses the flag.
 * Omitting `keys` drops every learned fact for the model.
 */
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

/**
 * Read, transform, write through a temporary file. Hand edits to sections this
 * write did not touch survive, since the whole parsed file is written back,
 * fields the parser does not model included. A rejected value is the one thing
 * a round trip cannot carry, so a file holding one is never written: the text
 * it would replace is the only copy of what the parse dropped.
 */
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

/**
 * Puts the fields the parser does not model back where they were. Parsed
 * values win: an unknown field never shadows one this file understands, and an
 * entry the update removed takes its unknown fields with it.
 */
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
