import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ModelReasoningEffort } from "./types.ts";

/**
 * A curated model suggestion: one model plus the reasoning setting it is
 * suggested at, with the reasoning for suggesting it. Shipped with Vera as
 * recommendation, never permission: absence from this file gates nothing.
 */
export interface TopPick {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly description: string;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface TopPicksCatalog {
    readonly schema_version: 1;
    readonly top_picks: readonly TopPick[];
}

const TOP_PICKS_PATH = fileURLToPath(
    new URL("../../config/top-picks.json", import.meta.url),
);

export function loadTopPicks(path = TOP_PICKS_PATH): readonly TopPick[] {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isTopPicksCatalog(value)) {
        throw new Error(`Invalid top-picks catalog at ${path}`);
    }
    return value.top_picks;
}

function isTopPicksCatalog(value: unknown): value is TopPicksCatalog {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const catalog = value as Record<string, unknown>;
    return catalog.schema_version === 1
        && Array.isArray(catalog.top_picks)
        && catalog.top_picks.every(isTopPick);
}

function isTopPick(value: unknown): value is TopPick {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const pick = value as Record<string, unknown>;
    return typeof pick.provider === "string"
        && pick.provider.trim().length > 0
        && typeof pick.model === "string"
        && pick.model.trim().length > 0
        && typeof pick.label === "string"
        && pick.label.trim().length > 0
        && typeof pick.description === "string"
        && (pick.reasoning_effort === undefined
            || (typeof pick.reasoning_effort === "string"
                && pick.reasoning_effort.length > 0));
}
