import type { VeraExtensionApi } from "../../../src/sdk/extensions.ts";
import type { PreTurnHookPayload, PreTurnHookResult } from "../../../src/sdk/hooks.ts";

export const TREASURE_HINT = "the crow buried it under the third palm";

export function activate(vera: VeraExtensionApi): void {
    vera.hooks.registerPreTurn(spotTreasure);
}

export function spotTreasure(turn: PreTurnHookPayload): PreTurnHookResult {
    if (!/\btreasure\b/i.test(turn.prompt)) {
        return { power: "observe" };
    }
    return { power: "mutate", context: TREASURE_HINT };
}
