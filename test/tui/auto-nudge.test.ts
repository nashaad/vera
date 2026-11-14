import { expect, test } from "bun:test";

import { autoNudgeWanted, rememberAutoNudge } from "../../clients/tui/auto-nudge.ts";
import { createTuiState } from "../../clients/tui/state.ts";

const suggested = { ...createTuiState(), suggestAuto: true as const };

test("the auto suggestion is wanted only for a suggested session not yet shown", () => {
    const shown = new Set<string>();
    expect(autoNudgeWanted(suggested, "agent-1", shown)).toBe(true);
    expect(autoNudgeWanted(createTuiState(), "agent-1", shown)).toBe(false);
    expect(autoNudgeWanted(suggested, undefined, shown)).toBe(false);

    rememberAutoNudge(shown, "agent-1");
    expect(autoNudgeWanted(suggested, "agent-1", shown)).toBe(false);
    expect(autoNudgeWanted(suggested, "agent-2", shown)).toBe(true);
});

test("the shown sessions are capped and drop the oldest first", () => {
    const shown = new Set<string>();
    rememberAutoNudge(shown, undefined);
    expect(shown.size).toBe(0);
    for (let index = 0; index < 205; index += 1) {
        rememberAutoNudge(shown, `agent-${index}`);
    }
    expect(shown.size).toBe(200);
    expect(shown.has("agent-0")).toBe(false);
    expect(shown.has("agent-4")).toBe(false);
    expect(shown.has("agent-5")).toBe(true);
    expect(shown.has("agent-204")).toBe(true);
});
