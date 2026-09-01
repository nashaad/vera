
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    return uniqueExactName(ref.model, overall);
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
