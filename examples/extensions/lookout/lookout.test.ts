import { expect, test } from "bun:test";

import { TREASURE_HINT, activate, spotTreasure } from "./extension.ts";

const turn = {
    type: "pre_turn" as const,
    workspace: "/ship",
    prompt: "where is the treasure?",
    arrivedDuringTurn: false,
    model: "crow",
    tools: ["read"],
};

test("the lookout adds the hint only when a prompt mentions treasure", () => {
    expect(spotTreasure(turn)).toEqual({ power: "mutate", context: TREASURE_HINT });
    expect(spotTreasure({ ...turn, prompt: "hoist the sails" })).toEqual({ power: "observe" });
});

test("the lookout registers one pre-turn hook", () => {
    const hooks: unknown[] = [];
    activate({ hooks: { registerPreTurn: (hook: never) => hooks.push(hook) } } as never);
    expect(hooks).toEqual([spotTreasure]);
});
