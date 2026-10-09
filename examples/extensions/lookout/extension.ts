import type { VeraExtensionApi } from "../../../src/sdk/extensions.ts";
import type {
    PreTurnHookPayload,
    PreTurnHookResult,
    TurnEndingHookPayload,
    TurnEndingHookResult,
} from "../../../src/sdk/hooks.ts";

export const TREASURE_HINT = "the crow buried it under the third palm";
export const MAP_REMINDER = "You said done but drew no map. Mark where the treasure is buried.";

export function activate(vera: VeraExtensionApi): void {
    vera.hooks.registerPreTurn(spotTreasure);
    vera.hooks.registerTurnEnding(askForTheMap);
}

export function spotTreasure(turn: PreTurnHookPayload): PreTurnHookResult {
    if (!/\btreasure\b/i.test(turn.prompt)) {
        return { power: "observe" };
    }
    return { power: "mutate", context: TREASURE_HINT };
}

export function askForTheMap(turn: TurnEndingHookPayload): TurnEndingHookResult {
    if (!/\bdone\b/i.test(turn.reply) || /\bmap\b/i.test(turn.reply)) {
        return { power: "observe" };
    }
    return { power: "continue", context: MAP_REMINDER };
}
