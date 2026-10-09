import { expect, test } from "bun:test";

import { MAP_REMINDER, TREASURE_HINT, activate, askForTheMap, spotTreasure } from "./extension.ts";

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

const ending = {
    type: "turn_ending" as const,
    workspace: "/ship",
    prompt: "find the treasure",
    reply: "done",
    spawned: false,
    continuations: 0,
};

test("the lookout sends the crew back once when a reply says done without a map", () => {
    expect(askForTheMap(ending)).toEqual({ power: "continue", context: MAP_REMINDER });
    expect(askForTheMap({ ...ending, reply: "done, map attached" })).toEqual({ power: "observe" });
    expect(askForTheMap({ ...ending, reply: "still digging" })).toEqual({ power: "observe" });
});

test("the lookout registers a pre-turn hook and a turn-ending hook", () => {
    const preTurn: unknown[] = [];
    const turnEnding: unknown[] = [];
    activate({
        hooks: {
            registerPreTurn: (hook: never) => preTurn.push(hook),
            registerTurnEnding: (hook: never) => turnEnding.push(hook),
        },
    } as never);
    expect(preTurn).toEqual([spotTreasure]);
    expect(turnEnding).toEqual([askForTheMap]);
});
