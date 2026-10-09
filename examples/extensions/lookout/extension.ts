import type { VeraExtensionApi } from "../../../src/sdk/extensions.ts";
import type {
    JsonValue,
    PreTurnHookPayload,
    PreTurnHookResult,
    TurnEndingHookPayload,
    TurnEndingHookResult,
} from "../../../src/sdk/hooks.ts";

export const TREASURE_HINT = "the crow buried it under the third palm";
export const MAP_REMINDER = "You said done but drew no map. Mark where the treasure is buried.";

export interface LookoutRows {
    readonly spotted: string;
    readonly nudge: string;
}

const MAX_WORD_CHARS = 60;

export const DEFAULT_ROWS: LookoutRows = { spotted: "Spotted", nudge: "Back to digging" };

// Words come from the extension's config.json entry: { "rows": { "spotted": "...", "nudge": "..." } }.
export function lookoutRows(config: JsonValue | undefined): LookoutRows {
    const rows = isObject(config) && isObject(config.rows) ? config.rows : {};
    return {
        spotted: word(rows.spotted) ?? DEFAULT_ROWS.spotted,
        nudge: word(rows.nudge) ?? DEFAULT_ROWS.nudge,
    };
}

export function activate(vera: VeraExtensionApi): void {
    const rows = lookoutRows(vera.config);
    vera.hooks.registerPreTurn((turn) => spotTreasure(turn, rows));
    vera.hooks.registerTurnEnding((turn) => askForTheMap(turn, rows));
}

export function spotTreasure(
    turn: PreTurnHookPayload,
    rows: LookoutRows = DEFAULT_ROWS,
): PreTurnHookResult {
    if (!/\btreasure\b/i.test(turn.prompt)) {
        return { power: "observe" };
    }
    return {
        power: "mutate",
        context: TREASURE_HINT,
        display: `${rows.spotted}: treasure under the third palm`,
    };
}

export function askForTheMap(
    turn: TurnEndingHookPayload,
    rows: LookoutRows = DEFAULT_ROWS,
): TurnEndingHookResult {
    if (!/\bdone\b/i.test(turn.reply) || /\bmap\b/i.test(turn.reply)) {
        return { power: "observe" };
    }
    return { power: "continue", context: MAP_REMINDER, display: `${rows.nudge}: no map drawn` };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A display Vera rejects drops the whole result, context included, so odd words fall back.
function word(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_WORD_CHARS || /[\p{Cc}\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(trimmed)) return undefined;
    return trimmed;
}
