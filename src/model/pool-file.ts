/**
 * The declarative pool file: the user-editable record of which models exist,
 * what they can do, and what may be selected.
 *
 * Two hands write this file. Everything outside `learned` is declared: either
 * a hand edit or a write Vera made on the user's explicit instruction. The
 * `learned` map holds only facts Vera concluded on its own (a provider
 * rejection, a probe result), so a machine conclusion can never present itself
 * as user intent. Declared values are never rewritten to match evidence; a
 * contradiction is recorded in `learned` instead.
 *
 * Parsing is lenient by design: a single malformed entry in a hand-edited file
 * drops that entry and reports an issue rather than failing the whole file and
 * leaving the user with no pool at all. Leniency is a read-side rule only: a
 * file that produced issues must never be written back, because the write
 * would serialize the reduced parse over the user's own text.
 *
 * `//` and block comments are accepted. The documented example of this file is
 * annotated, so a user who copies it must not end up with a file Vera treats
 * as broken.
 */

import {
    EFFORT_LADDER,
    type EffortMap,
    isEffortLevel,
} from "./effort-ladder.ts";

/**
 * A fact Vera concluded on its own, with the evidence that produced it.
 *
 * `wire` is the provider string the probe actually sent for a passing effort
 * level. A learned level with no declared counterpart would otherwise have no
 * way to say which word worked, and guessing the provider's word from Vera's
 * ladder name is exactly the translation the pool exists to avoid.
 *
 * `checked` names who vouches: `user_key` for a probe run against the user's
 * own credentials, `vera` for a centrally tested result.
 */
export interface LearnedFact {
    readonly ok: boolean;
    readonly seen: string;
    readonly error?: string;
    readonly wire?: string;
    readonly checked?: "user_key" | "vera";
}

/**
 * Keys are dotted paths into the declared shape (`efforts.xhigh`, `tools`), so
 * a learned fact and the declared field it contradicts are addressable the
 * same way.
 */
export type LearnedFacts = Readonly<Record<string, LearnedFact>>;

/**
 * The model answered at all. Absent means it has never been probed. Its `wire`
 * carries whatever model string the provider answered with, recorded verbatim
 * and never gated on: aggregator routes legitimately alias and version names.
 */
export const PROBE_LEARNED_KEY = "probe";

/** The model called a tool when asked to. */
export const TOOLS_LEARNED_KEY = "tools";

export function effortLearnedKey(level: string): string {
    return `efforts.${level}`;
}

export interface PoolFileModel {
    /**
     * The user put this model in their pool. Written by `pool_add` and by
     * nothing else, which is what tells a curated entry apart from one that
     * exists only to hold facts learned about a model the user never pooled.
     */
    readonly added?: boolean;
    /** Declared label bounding sibling search inside one provider. */
    readonly family?: string;
    readonly tools?: boolean;
    readonly context?: number;
    readonly efforts?: EffortMap;
    /** Same-provider model ids only. */
    readonly fallback?: readonly string[];
    readonly learned?: LearnedFacts;
}

/** `"self"`, `"lowest"`, `"equal"`, or an explicit ladder level. */
export type SubagentEffort = string;

export interface PoolFileDefaults {
    readonly subagent?: string;
    readonly subagentEffort?: SubagentEffort;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}

export interface PoolFile {
    readonly defaults: PoolFileDefaults;
    /** Keyed by `<provider>/<model>`. */
    readonly models: Readonly<Record<string, PoolFileModel>>;
}

/**
 * `error` means a value was dropped. `warning` means everything was kept but
 * something in the file has no effect, which is what a typo looks like: an
 * unknown key is silently ignored by a lenient parser, so the only way the
 * user learns of it is an issue that says so.
 */
export type PoolFileIssueSeverity = "error" | "warning";

/** Where a rejected value sat, as a dotted path, plus why it was rejected. */
export interface PoolFileIssue {
    readonly path: string;
    readonly message: string;
    /** Absent reads as `error`; only a warning has to say so. */
    readonly severity?: PoolFileIssueSeverity;
}

export function issueSeverity(issue: PoolFileIssue): PoolFileIssueSeverity {
    return issue.severity ?? "error";
}

/**
 * The fields the parser does not model, kept verbatim so a write can put them
 * back where they were. They are deliberately not part of `PoolFile`: nothing
 * reading the pool should see them, and only the writer needs them.
 */
export interface PreservedPoolFields {
    readonly root: Readonly<Record<string, unknown>>;
    readonly defaults: Readonly<Record<string, unknown>>;
    /** Keyed by model id, holding that entry's own unknown fields. */
    readonly models: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const NO_PRESERVED_POOL_FIELDS: PreservedPoolFields = {
    root: {},
    defaults: {},
    models: {},
};

export interface ParsedPoolFile {
    readonly file: PoolFile;
    readonly issues: readonly PoolFileIssue[];
    readonly preserved: PreservedPoolFields;
}

export const EMPTY_POOL_FILE: PoolFile = {
    defaults: {},
    models: {},
};

export function parsePoolFileText(text: string): ParsedPoolFile {
    let value: unknown;
    try {
        value = JSON.parse(stripJsonComments(text));
    } catch (error) {
        return {
            file: EMPTY_POOL_FILE,
            issues: [{
                path: "",
                message: error instanceof Error ? error.message : "invalid JSON",
            }],
            preserved: NO_PRESERVED_POOL_FIELDS,
        };
    }
    return parsePoolFile(value);
}

export function parsePoolFile(value: unknown): ParsedPoolFile {
    const issues: PoolFileIssue[] = [];
    const record = asRecord(value);
    if (record === undefined) {
        return {
            file: EMPTY_POOL_FILE,
            issues: [{ path: "", message: "expected a JSON object" }],
            preserved: NO_PRESERVED_POOL_FIELDS,
        };
    }

    const models: Record<string, Record<string, unknown>> = {};
    const root = warnUnknownKeys(record, ROOT_KEYS, "", issues);
    const defaults: Record<string, unknown> = {};
    return {
        file: {
            defaults: parseDefaults(record.defaults, issues, defaults),
            models: parseModels(record.models, issues, models),
        },
        issues,
        preserved: { root, defaults, models },
    };
}

const ROOT_KEYS = ["defaults", "models"] as const;
const DEFAULTS_KEYS = [
    "subagent",
    "subagentEffort",
    "allow",
    "deny",
] as const;
const MODEL_KEYS = [
    "added",
    "family",
    "tools",
    "context",
    "efforts",
    "fallback",
    "learned",
] as const;

/**
 * A key the parser does not model has no effect, so a mistyped field looks
 * exactly like a field that does nothing. The warning is the only thing
 * standing between a typo and a setting the user believes is in force.
 *
 * Returns those keys with their values, which is what lets a write put them
 * back rather than drop them on the user's behalf.
 */
function warnUnknownKeys(
    record: Record<string, unknown>,
    known: readonly string[],
    path: string,
    issues: PoolFileIssue[],
): Record<string, unknown> {
    const unknown: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        if (known.includes(key)) {
            continue;
        }
        unknown[key] = record[key];
        issues.push({
            path: path === "" ? key : `${path}.${key}`,
            message: `unknown field, kept but has no effect; expected one of ${
                known.join(", ")
            }`,
            severity: "warning",
        });
    }
    return unknown;
}

/**
 * Whether the user put this entry in their pool, as opposed to it existing only
 * to hold what Vera learned about a model that was run without being pooled.
 *
 * `added` says so outright. So does any other declared field, and so does an
 * empty entry: a hand-written `{}` is a user naming a model, and only an entry
 * that holds nothing but `learned` was written without being asked for.
 */
export function isCuratedPoolEntry(entry: PoolFileModel): boolean {
    return entry.learned === undefined || Object.keys(entry).length > 1;
}

/** Whether a probe has run against this entry and answered. */
export function isVerifiedPoolEntry(entry: PoolFileModel): boolean {
    return entry.learned?.[PROBE_LEARNED_KEY]?.ok === true;
}

/**
 * The provider half of a pool id. Fallback validation and sibling search both
 * need it, and both must refuse to cross it.
 */
export function providerOf(modelId: string): string | undefined {
    const separator = modelId.indexOf("/");
    if (separator <= 0 || separator === modelId.length - 1) {
        return undefined;
    }
    return modelId.slice(0, separator);
}

function parseDefaults(
    value: unknown,
    issues: PoolFileIssue[],
    preserved: Record<string, unknown>,
): PoolFileDefaults {
    const record = asRecord(value);
    if (record === undefined) {
        if (value !== undefined) {
            issues.push({ path: "defaults", message: "expected an object" });
        }
        return {};
    }

    Object.assign(
        preserved,
        warnUnknownKeys(record, DEFAULTS_KEYS, "defaults", issues),
    );
    const subagent = asNonEmptyString(record.subagent);
    if (record.subagent !== undefined && subagent === undefined) {
        issues.push({
            path: "defaults.subagent",
            message: "expected \"self\" or a model id",
        });
    }
    const subagentEffort = asNonEmptyString(record.subagentEffort);
    if (record.subagentEffort !== undefined && subagentEffort === undefined) {
        issues.push({
            path: "defaults.subagentEffort",
            message: "expected \"lowest\", \"equal\", or a level name",
        });
    }

    const allow = record.allow === undefined
        ? undefined
        : parseStringList(record.allow, "defaults.allow", issues);
    const deny = record.deny === undefined
        ? undefined
        : parseStringList(record.deny, "defaults.deny", issues);

    return {
        ...(subagent === undefined ? {} : { subagent }),
        ...(subagentEffort === undefined ? {} : { subagentEffort }),
        ...(allow === undefined ? {} : { allow }),
        ...(deny === undefined ? {} : { deny }),
    };
}

function parseModels(
    value: unknown,
    issues: PoolFileIssue[],
    preserved: Record<string, Record<string, unknown>>,
): Readonly<Record<string, PoolFileModel>> {
    const record = asRecord(value);
    if (record === undefined) {
        if (value !== undefined) {
            issues.push({ path: "models", message: "expected an object" });
        }
        return {};
    }

    const models: Record<string, PoolFileModel> = {};
    for (const [id, entry] of Object.entries(record)) {
        const path = `models.${id}`;
        const provider = providerOf(id);
        if (provider === undefined) {
            issues.push({
                path,
                message: "model id must be \"<provider>/<model>\"",
            });
            continue;
        }
        const unknown: Record<string, unknown> = {};
        const parsed = parseModel(entry, provider, path, issues, unknown);
        if (parsed !== undefined) {
            models[id] = parsed;
            if (Object.keys(unknown).length > 0) {
                preserved[id] = unknown;
            }
        }
    }
    return models;
}

function parseModel(
    value: unknown,
    provider: string,
    path: string,
    issues: PoolFileIssue[],
    preserved: Record<string, unknown>,
): PoolFileModel | undefined {
    const record = asRecord(value);
    if (record === undefined) {
        issues.push({ path, message: "expected an object" });
        return undefined;
    }

    Object.assign(
        preserved,
        warnUnknownKeys(record, MODEL_KEYS, path, issues),
    );
    let added: boolean | undefined;
    if (typeof record.added === "boolean") {
        added = record.added;
    } else if (record.added !== undefined) {
        issues.push({ path: `${path}.added`, message: "expected a boolean" });
    }
    const family = asNonEmptyString(record.family);
    if (record.family !== undefined && family === undefined) {
        issues.push({ path: `${path}.family`, message: "expected a string" });
    }

    let tools: boolean | undefined;
    if (typeof record.tools === "boolean") {
        tools = record.tools;
    } else if (record.tools !== undefined) {
        issues.push({ path: `${path}.tools`, message: "expected a boolean" });
    }

    let context: number | undefined;
    if (
        typeof record.context === "number" && Number.isFinite(record.context)
        && record.context > 0
    ) {
        context = record.context;
    } else if (record.context !== undefined) {
        issues.push({
            path: `${path}.context`,
            message: "expected a positive number",
        });
    }

    return {
        ...(added === undefined ? {} : { added }),
        ...(family === undefined ? {} : { family }),
        ...(tools === undefined ? {} : { tools }),
        ...(context === undefined ? {} : { context }),
        ...parseEfforts(record.efforts, path, issues),
        ...parseFallback(record.fallback, provider, path, issues),
        ...parseLearned(record.learned, path, issues),
    };
}

function parseEfforts(
    value: unknown,
    path: string,
    issues: PoolFileIssue[],
): { efforts?: EffortMap } {
    if (value === undefined) {
        return {};
    }
    const record = asRecord(value);
    if (record === undefined) {
        issues.push({ path: `${path}.efforts`, message: "expected an object" });
        return {};
    }

    const efforts: Record<string, string | null> = {};
    for (const [level, wire] of Object.entries(record)) {
        const levelPath = `${path}.efforts.${level}`;
        if (!isEffortLevel(level)) {
            issues.push({
                path: levelPath,
                message: `unknown effort level, expected one of ${
                    EFFORT_LADDER.join(", ")
                }`,
            });
            continue;
        }
        if (wire === null) {
            efforts[level] = null;
            continue;
        }
        const wireString = asNonEmptyString(wire);
        if (wireString === undefined) {
            issues.push({
                path: levelPath,
                message: "expected null or the provider wire string",
            });
            continue;
        }
        efforts[level] = wireString;
    }
    return { efforts };
}

/**
 * Fallback never leaves the provider of the model that declares it. A model on
 * one host is a different deployment from the same-named model on another, so
 * a cross-provider reference is dropped rather than followed.
 */
function parseFallback(
    value: unknown,
    provider: string,
    path: string,
    issues: PoolFileIssue[],
): { fallback?: readonly string[] } {
    if (value === undefined) {
        return {};
    }
    const listed = parseStringList(value, `${path}.fallback`, issues);
    const fallback = listed.filter((reference) => {
        const referenceProvider = providerOf(reference);
        if (referenceProvider === undefined) {
            issues.push({
                path: `${path}.fallback`,
                message: `"${reference}" must be "<provider>/<model>"`,
            });
            return false;
        }
        if (referenceProvider !== provider) {
            issues.push({
                path: `${path}.fallback`,
                message: `"${reference}" is on provider "${referenceProvider}"`
                    + `, not "${provider}"; fallback stays inside one provider`,
            });
            return false;
        }
        return true;
    });
    return { fallback };
}

function parseLearned(
    value: unknown,
    path: string,
    issues: PoolFileIssue[],
): { learned?: LearnedFacts } {
    if (value === undefined) {
        return {};
    }
    const record = asRecord(value);
    if (record === undefined) {
        issues.push({ path: `${path}.learned`, message: "expected an object" });
        return {};
    }

    const learned: Record<string, LearnedFact> = {};
    for (const [key, fact] of Object.entries(record)) {
        const factPath = `${path}.learned.${key}`;
        const factRecord = asRecord(fact);
        if (
            factRecord === undefined || typeof factRecord.ok !== "boolean"
            || typeof factRecord.seen !== "string"
        ) {
            issues.push({
                path: factPath,
                message: "expected { ok: boolean, seen: string, error?: string }",
            });
            continue;
        }
        const error = asNonEmptyString(factRecord.error);
        const wire = asNonEmptyString(factRecord.wire);
        const checked = factRecord.checked === "user_key"
                || factRecord.checked === "vera"
            ? factRecord.checked
            : undefined;
        learned[key] = {
            ok: factRecord.ok,
            seen: factRecord.seen,
            ...(error === undefined ? {} : { error }),
            ...(wire === undefined ? {} : { wire }),
            ...(checked === undefined ? {} : { checked }),
        };
    }
    return { learned };
}

function parseStringList(
    value: unknown,
    path: string,
    issues: PoolFileIssue[],
): readonly string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        issues.push({ path, message: "expected an array of strings" });
        return [];
    }
    return value.flatMap((item) => {
        const text = asNonEmptyString(item);
        if (text === undefined) {
            issues.push({ path, message: "expected an array of strings" });
            return [];
        }
        return [text];
    });
}

/**
 * Blanks `//` and block comments outside string literals, keeping every other
 * character at its original offset so a parse error still points at the line
 * the user is looking at. Escapes inside strings are honoured, so a `"//"` or
 * a trailing backslash cannot end a string early and swallow the rest of the
 * file.
 */
export function stripJsonComments(text: string): string {
    const out = [...text];
    let index = 0;
    let inString = false;
    while (index < text.length) {
        const character = text[index] as string;
        if (inString) {
            if (character === "\\") {
                index += 2;
                continue;
            }
            if (character === "\"") {
                inString = false;
            }
            index += 1;
            continue;
        }
        if (character === "\"") {
            inString = true;
            index += 1;
            continue;
        }
        if (character === "/" && text[index + 1] === "/") {
            while (index < text.length && text[index] !== "\n") {
                out[index] = " ";
                index += 1;
            }
            continue;
        }
        if (character === "/" && text[index + 1] === "*") {
            const end = text.indexOf("*/", index + 2);
            const stop = end === -1 ? text.length : end + 2;
            while (index < stop) {
                out[index] = text[index] === "\n" ? "\n" : " ";
                index += 1;
            }
            continue;
        }
        index += 1;
    }
    return out.join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
