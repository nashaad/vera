import { expect, test } from "bun:test";

import {
    DEFAULT_ROWS,
    MAP_REMINDER,
    TREASURE_HINT,
    activate,
    askForTheMap,
    lookoutRows,
    spotTreasure,
} from "./extension.ts";

const turn = {
    type: "pre_turn" as const,
    workspace: "/ship",
    prompt: "where is the treasure?",
    arrivedDuringTurn: false,
    spawned: false,
    model: "crow",
    tools: ["read"],
};

test("the lookout adds the hint only when a prompt mentions treasure", () => {
    expect(spotTreasure(turn)).toEqual({
        power: "mutate",
        context: TREASURE_HINT,
        display: "Spotted: treasure under the third palm",
    });
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
    expect(askForTheMap(ending)).toEqual({
        power: "continue",
        context: MAP_REMINDER,
        display: "Back to digging: no map drawn",
    });
    expect(askForTheMap({ ...ending, reply: "done, map attached" })).toEqual({ power: "observe" });
    expect(askForTheMap({ ...ending, reply: "still digging" })).toEqual({ power: "observe" });
});

test("the row words come from config, with defaults for anything missing or blank", () => {
    expect(lookoutRows(undefined)).toEqual(DEFAULT_ROWS);
    expect(lookoutRows({ rows: { spotted: " Land ho ", nudge: "" } })).toEqual({
        spotted: "Land ho",
        nudge: "Back to digging",
    });
    expect(lookoutRows({ rows: { spotted: 7 } })).toEqual(DEFAULT_ROWS);
});

test("the lookout registers both hooks with the words from its config", async () => {
    const preTurn: ((payload: typeof turn) => unknown)[] = [];
    const turnEnding: ((payload: typeof ending) => unknown)[] = [];
    activate({
        config: { rows: { spotted: "Land ho", nudge: "Keep digging" } },
        hooks: {
            registerPreTurn: (hook: never) => preTurn.push(hook),
            registerTurnEnding: (hook: never) => turnEnding.push(hook),
        },
    } as never);
    expect(preTurn).toHaveLength(1);
    expect(turnEnding).toHaveLength(1);
    expect(await preTurn[0]?.(turn)).toMatchObject({ display: "Land ho: treasure under the third palm" });
    expect(await turnEnding[0]?.(ending)).toMatchObject({ display: "Keep digging: no map drawn" });
});
