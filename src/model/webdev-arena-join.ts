
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    EFFORT_LADDER,
    isEffortLevel,
    type EffortLevel,
} from "./effort-ladder.ts";
import type { WebDevArenaRow, WebDevArenaSnapshot } from "./webdev-arena.ts";

export interface WebDevArenaAliases {
    readonly schema_version: 1;
    readonly aliases: Readonly<Record<string, string>>;
}

export interface WebDevJoinRef {
    readonly provider: string;
    readonly model: string;
    readonly recommendedLevel?: string;
}

const ALIASES_PATH = fileURLToPath(
    new URL("../../config/webdev-arena-aliases.json", import.meta.url),
);

let shipped: WebDevArenaAliases | undefined;

export function loadWebDevArenaAliases(
    path = ALIASES_PATH,
): WebDevArenaAliases {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isWebDevArenaAliases(value)) {
        throw new Error(`Invalid WebDev Arena aliases at ${path}`);
    }
    return value;
}

function shippedAliases(): WebDevArenaAliases {
    if (shipped === undefined) {
        try {
            shipped = loadWebDevArenaAliases();
        } catch {
            shipped = { schema_version: 1, aliases: {} };
        }
    }
    return shipped;
}

export function joinWaScore(
    ref: WebDevJoinRef,
    snapshot: WebDevArenaSnapshot | undefined,
    aliases: WebDevArenaAliases = shippedAliases(),
): number | undefined {
    if (snapshot === undefined) {
        return undefined;
    }
    const overall = snapshot.rows.filter((row) => row.category === "overall");
    const name = arenaNameFor(ref, aliases, overall);
    if (name === undefined) {
        return undefined;
    }
    const row = overall.find((candidate) => candidate.model_name === name);
    if (row === undefined || !Number.isFinite(row.rating)) {
        return undefined;
    }
    return Math.round(row.rating);
}

function arenaNameFor(
    ref: WebDevJoinRef,
    aliases: WebDevArenaAliases,
    overall: readonly WebDevArenaRow[],
): string | undefined {
    const id = `${ref.provider}/${ref.model}`;
    if (ref.recommendedLevel !== undefined) {
        const keyed = aliases.aliases[`${id}@${ref.recommendedLevel}`];
        if (keyed !== undefined) {
            return keyed;
        }
    }
    const exactAlias = aliases.aliases[id];
    if (exactAlias !== undefined) {
        return exactAlias;
    }
    return uniqueExactName(ref.model, overall)
        ?? effortVariantName(ref, overall);
}

const HARNESS_MARKER = " (codex-harness)";

interface EffortVariant {
    readonly name: string;
    readonly base: string;
    readonly effort: EffortLevel;
}

/**
 * Leaderboard rows label a model with the rung it was run at, as a trailing
 * "-max" or a trailing " (xHigh)", and mark codex-harness runs in parentheses.
 * Model ids carry neither, so the rung is folded off the row name. Only the row
 * name is folded: an id may end in a ladder word of its own, as
 * openai/gpt-5.1-codex-max does, and that word is part of its name.
 */
function effortVariantName(
    ref: WebDevJoinRef,
    overall: readonly WebDevArenaRow[],
): string | undefined {
    const last = lastSegment(ref.model);
    const variants: EffortVariant[] = [];
    for (const row of overall) {
        const variant = asEffortVariant(row.model_name);
        if (
            variant !== undefined
            && (variant.base === ref.model || variant.base === last)
        ) {
            variants.push(variant);
        }
    }
    if (variants.length === 0) {
        return undefined;
    }
    const asked = ref.recommendedLevel;
    if (asked !== undefined) {
        const exact = variants.filter((variant) => variant.effort === asked);
        if (exact.length === 1) {
            return exact[0]?.name;
        }
    }
    const ceiling = variants.reduce(
        (highest, variant) =>
            rung(variant.effort) > rung(highest.effort) ? variant : highest,
        variants[0]!,
    );
    const tied = variants.filter((variant) =>
        variant.effort === ceiling.effort
    );
    return tied.length === 1 ? ceiling.name : undefined;
}

function asEffortVariant(name: string): EffortVariant | undefined {
    const unharnessed = name.toLowerCase().endsWith(HARNESS_MARKER)
        ? name.slice(0, name.length - HARNESS_MARKER.length)
        : name;
    const level = parenthesizedRung(unharnessed) ?? suffixedRung(unharnessed);
    return level === undefined ? undefined : { name, ...level };
}

function parenthesizedRung(
    name: string,
): { readonly base: string; readonly effort: EffortLevel } | undefined {
    if (!name.endsWith(")")) {
        return undefined;
    }
    const open = name.lastIndexOf(" (");
    if (open <= 0) {
        return undefined;
    }
    const effort = name.slice(open + 2, name.length - 1).toLowerCase();
    return isEffortLevel(effort)
        ? { base: name.slice(0, open), effort }
        : undefined;
}

function suffixedRung(
    name: string,
): { readonly base: string; readonly effort: EffortLevel } | undefined {
    const dash = name.lastIndexOf("-");
    if (dash <= 0) {
        return undefined;
    }
    const effort = name.slice(dash + 1).toLowerCase();
    return isEffortLevel(effort)
        ? { base: name.slice(0, dash), effort }
        : undefined;
}

function rung(effort: EffortLevel): number {
    return EFFORT_LADDER.indexOf(effort);
}

function uniqueExactName(
    modelId: string,
    overall: readonly WebDevArenaRow[],
): string | undefined {
    const last = lastSegment(modelId);
    const matches = overall.filter((row) =>
        row.model_name === modelId || row.model_name === last
    );
    return matches.length === 1 ? matches[0]?.model_name : undefined;
}

function lastSegment(modelId: string): string {
    const slash = modelId.lastIndexOf("/");
    return slash === -1 ? modelId : modelId.slice(slash + 1);
}

function isWebDevArenaAliases(value: unknown): value is WebDevArenaAliases {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const catalog = value as Record<string, unknown>;
    if (catalog.schema_version !== 1 || !isStringRecord(catalog.aliases)) {
        return false;
    }
    return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    return Object.values(value).every((entry) => typeof entry === "string");
}
