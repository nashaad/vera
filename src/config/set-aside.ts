import {
    chmodSync,
    copyFileSync,
    existsSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { checkVeraConfigValue, VeraConfigError } from "../config.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

// Without these Vera has nothing to run on, so a bad one is a whole-file matter.
const REQUIRED_KEYS = new Set(["schema_version", "model", "provider"]);

const MAX_PREVIEW = 80;

type Segment = string | number;

export interface ConfigSetAsidePlan {
    readonly path: string;
    readonly kind: "entry" | "file";
    // What is taken out of the config, such as `extensions[5]`; empty for a whole-file move.
    readonly field: string;
    // The text of the removed entry, cut short for the prompt.
    readonly preview: string;
    readonly question: string;
    readonly segments: readonly Segment[];
}

export interface ConfigSetAsideResult {
    readonly kind: "entry" | "file";
    readonly field: string;
    readonly backupPath: string;
    readonly summary: string;
}

/**
 * What one answer of yes does for a config Vera refused. A field the parser
 * named is set aside on its own when removing it leaves a file that is better
 * off; anything else (invalid JSON, a missing required key) moves the file.
 */
export function planConfigSetAside(
    error: VeraConfigError,
): ConfigSetAsidePlan | undefined {
    const path = error.path;
    let root: unknown;
    try {
        root = JSON.parse(readRegularFileTextSync(path));
    } catch {
        return wholeFile(path);
    }
    if (!isContainer(root) || Array.isArray(root) || error.field === undefined) {
        return wholeFile(path);
    }
    const located = locate(root, error.field);
    if (located === undefined || REQUIRED_KEYS.has(String(located[0]))) {
        return wholeFile(path);
    }
    for (let length = located.length; length >= 1; length -= 1) {
        const segments = located.slice(0, length);
        const field = formatField(segments);
        if (typeof segments[length - 1] === "number" || improves(path, root, segments, field)) {
            const removed = valueAt(root, segments);
            return {
                path,
                kind: "entry",
                field,
                preview: preview(removed),
                segments,
                question: `Set aside ${field} (${preview(removed)}) and start Vera?`
                    + " A copy of the whole file is saved first.",
            };
        }
    }
    return wholeFile(path);
}

function wholeFile(path: string): ConfigSetAsidePlan {
    return {
        path,
        kind: "file",
        field: "",
        preview: "",
        segments: [],
        question: `Move ${path} aside and start with first-run setup?`
            + " The file is kept as a backup beside it.",
    };
}

/** Saves a timestamped copy of the file beside it, then removes the planned entry or moves the file. */
export function applyConfigSetAside(
    plan: ConfigSetAsidePlan,
    now: Date = new Date(),
): ConfigSetAsideResult {
    const backupPath = backupName(plan.path, now);
    if (plan.kind === "file") {
        renameSync(plan.path, backupPath);
        return {
            kind: "file",
            field: "",
            backupPath,
            summary: `Moved ${plan.path} to ${backupPath}.`,
        };
    }
    copyFileSync(plan.path, backupPath);
    chmodSync(backupPath, 0o600);
    const root = JSON.parse(readRegularFileTextSync(plan.path)) as unknown;
    removeAt(root, plan.segments);
    const temporaryPath = join(dirname(plan.path), `.config-${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, plan.path);
    return {
        kind: "entry",
        field: plan.field,
        backupPath,
        summary: `Removed ${plan.field} from ${plan.path}. The whole file before the change is at ${backupPath}.`,
    };
}

function backupName(path: string, now: Date): string {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const base = join(dirname(path), `${basename(path)}.${stamp}`);
    for (let attempt = 0; ; attempt += 1) {
        const candidate = `${base}${attempt === 0 ? "" : `-${attempt + 1}`}.bak`;
        if (!existsSync(candidate)) return candidate;
    }
}

// Removing a key must change the outcome: a file that still fails on the same field is no better.
function improves(
    path: string,
    root: unknown,
    segments: readonly Segment[],
    field: string,
): boolean {
    const copy = structuredClone(root);
    removeAt(copy, segments);
    try {
        checkVeraConfigValue(path, copy);
        return true;
    } catch (error) {
        return !(error instanceof VeraConfigError) || error.field !== field;
    }
}

function removeAt(root: unknown, segments: readonly Segment[]): void {
    const parent = valueAt(root, segments.slice(0, -1));
    const last = segments[segments.length - 1]!;
    if (Array.isArray(parent) && typeof last === "number") {
        parent.splice(last, 1);
    } else if (isContainer(parent)) {
        delete (parent as Record<string, unknown>)[String(last)];
    }
}

function valueAt(root: unknown, segments: readonly Segment[]): unknown {
    let current = root;
    for (const segment of segments) {
        current = (current as Record<string, unknown>)[String(segment)];
    }
    return current;
}

// A key can hold a dot, so a field is matched against the keys the file really has.
function locate(root: unknown, field: string): readonly Segment[] | undefined {
    if (field.length === 0) return [];
    if (!isContainer(root)) return undefined;
    if (Array.isArray(root)) {
        const match = /^\[(\d+)\](.*)$/.exec(field);
        if (match === null) return undefined;
        const index = Number(match[1]);
        if (index >= root.length) return undefined;
        const rest = locate(root[index], match[2]!.replace(/^\./, ""));
        return rest === undefined ? undefined : [index, ...rest];
    }
    const object = root as Record<string, unknown>;
    for (const key of Object.keys(object).sort((a, b) => b.length - a.length)) {
        if (!field.startsWith(key)) continue;
        const rest = field.slice(key.length);
        if (rest.length > 0 && rest[0] !== "." && rest[0] !== "[") continue;
        const tail = locate(object[key], rest.replace(/^\./, ""));
        if (tail !== undefined) return [key, ...tail];
    }
    return undefined;
}

function formatField(segments: readonly Segment[]): string {
    return segments.reduce<string>((text, segment) =>
        typeof segment === "number"
            ? `${text}[${segment}]`
            : text.length === 0 ? segment : `${text}.${segment}`, "");
}

function preview(value: unknown): string {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 3)}...` : text;
}

function isContainer(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}
