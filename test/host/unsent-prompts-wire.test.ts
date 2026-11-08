import { expect, test } from "bun:test";

import { parseAgentUpdate, parseAgentUpdateFrame } from "../../src/host/agent-update-wire.ts";

test("history carries structured unsent prompts and rejects malformed facts", () => {
    const history = {
        type: "history" as const, seq: 0, entries: [],
        unsentPrompts: [{ content: "Inspect the deck", attachmentIds: ["image-1"] }],
    };
    expect(parseAgentUpdate(history)).toEqual(history);
    expect(parseAgentUpdate({ ...history, unsentPrompts: [{ content: 4 }] })).toBeUndefined();
    expect(parseAgentUpdate({ ...history, unsentPrompts: [{ content: "deck", attachmentIds: [4] }] })).toBeUndefined();
    expect(parseAgentUpdateFrame({ type: "future_update", seq: 1 })).toEqual({ kind: "unknown", seq: 1 });
});

test("prompt admission validates its acknowledgement and rejection", () => {
    const accepted = { type: "prompt_admission" as const, seq: 1, requestId: "one", content: "deck", status: "accepted" as const };
    expect(parseAgentUpdate(accepted)).toEqual(accepted);
    expect(parseAgentUpdate({ ...accepted, status: "rejected", reason: "Could not save the queued prompt." })).toBeDefined();
    expect(parseAgentUpdate({ ...accepted, status: "rejected" })).toBeUndefined();
    expect(parseAgentUpdate({ ...accepted, requestId: 3 })).toBeUndefined();
});
