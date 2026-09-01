/** The declarative pool file: the user-editable record of which models exist, what they can do, and what may be selected. */

import {
    EFFORT_LADDER,
    type EffortMap,
    isEffortLevel,
} from "./effort-ladder.ts";

/** A fact Vera concluded on its own, with the evidence that produced it. `wire` is the provider string the probe actually sent for a passing effort level. */
export interface LearnedFact {
    readonly ok: boolean;
    readonly seen: string;
    readonly error?: string;
    readonly wire?: string;
    readonly checked?: "user_key" | "vera";
}

export type LearnedFacts = Readonly<Record<string, LearnedFact>>;

export const PROBE_LEARNED_KEY = "probe";

export const TOOLS_LEARNED_KEY = "tools";

export const IMAGES_LEARNED_KEY = "images";

export function effortLearnedKey(level: string): string {
    return `efforts.${level}`;
}

export const POOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface PoolFileModel {
    readonly added?: boolean;
    readonly name?: string;
    readonly family?: string;
    readonly tools?: boolean;
    readonly images?: boolean;
    readonly context?: number;
    readonly efforts?: EffortMap;
    readonly fallback?: readonly string[];
    readonly learned?: LearnedFacts;
}

export type SubagentEffort = string;

export interface PoolFileDefaults {
    readonly subagent?: string;
    readonly subagentEffort?: SubagentEffort;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}

export interface PoolFile {
    readonly defaults: PoolFileDefaults;
    readonly models: Readonly<Record<string, PoolFileModel>>;
}

export type PoolFileIssueSeverity = "error" | "warning";

export interface PoolFileIssue {
    readonly path: string;
    readonly message: string;
    readonly severity?: PoolFileIssueSeverity;
}

export function issueSeverity(issue: PoolFileIssue): PoolFileIssueSeverity {
    return issue.severity ?? "error";
}

export interface PreservedPoolFields {
    readonly root: Readonly<Record<string, unknown>>;
    readonly defaults: Readonly<Record<string, unknown>>;
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
    "name",
    "family",
    "tools",
    "images",
    "context",
    "efforts",
    "fallback",
    "learned",
] as const;

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

export function isCuratedPoolEntry(entry: PoolFileModel): boolean {
    return entry.learned === undefined || Object.keys(entry).length > 1;
}

export function isVerifiedPoolEntry(entry: PoolFileModel): boolean {
    return entry.learned?.[PROBE_LEARNED_KEY]?.ok === true;
}

/** The provider half of a pool id. Fallback validation and sibling search both need it, and both must refuse to cross it. */
export function providerOf(modelId: string): string | undefined {
    const separator = modelId.indexOf("/");
    if (separator <= 0 || separator === modelId.length - 1) {
        return undefined;
    }
    return modelId.slice(0, separator);
}

export function splitModelId(
    modelId: string,
): { readonly provider: string; readonly model: string } | undefined {
    const provider = providerOf(modelId);
    if (provider === undefined) return undefined;
    return { provider, model: modelId.slice(provider.length + 1) };
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
    warnDuplicateNames(models, issues);
    return models;
}

function warnDuplicateNames(
    models: Readonly<Record<string, PoolFileModel>>,
    issues: PoolFileIssue[],
): void {
    const owners = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(models)) {
        if (entry.name === undefined) {
            continue;
        }
        owners.set(entry.name, [...owners.get(entry.name) ?? [], id]);
    }
    for (const [name, ids] of owners) {
        if (ids.length < 2) {
            continue;
        }
        for (const id of ids) {
            issues.push({
                path: `models.${id}.name`,
                message: `"${name}" names ${ids.length} entries, so it names none`,
            });
        }
    }
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
    const name = parsePoolName(record.name, path, issues);
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

    let images: boolean | undefined;
    if (typeof record.images === "boolean") {
        images = record.images;
    } else if (record.images !== undefined) {
        issues.push({ path: `${path}.images`, message: "expected a boolean" });
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
        ...(name === undefined ? {} : { name }),
        ...(family === undefined ? {} : { family }),
        ...(tools === undefined ? {} : { tools }),
        ...(images === undefined ? {} : { images }),
        ...(context === undefined ? {} : { context }),
        ...parseEfforts(record.efforts, path, issues),
        ...parseFallback(record.fallback, provider, path, issues),
        ...parseLearned(record.learned, path, issues),
    };
}

function parsePoolName(
    value: unknown,
    path: string,
    issues: PoolFileIssue[],
): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const name = asNonEmptyString(value);
    if (name === undefined || !POOL_NAME_PATTERN.test(name)) {
        issues.push({
            path: `${path}.name`,
            message: "expected lowercase letters, digits, - or _, no slash",
        });
        return undefined;
    }
    return name;
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
