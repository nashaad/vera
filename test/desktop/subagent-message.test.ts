import { expect, test } from "bun:test";

import { messageEnterAction, messagePlaceholder } from "../../clients/ui/src/subagents/messageBox.ts";

const base = { shift: false, composing: false, empty: false, running: false, queued: false };

test("@core Enter sends text, steers with what is queued, and never stops the subagent", () => {
    expect(messageEnterAction(base)).toBe("send");
    expect(messageEnterAction({ ...base, running: true })).toBe("send");
    expect(messageEnterAction({ ...base, empty: true, running: true, queued: true })).toBe("steer");
    expect(messageEnterAction({ ...base, empty: true, running: true })).toBe("none");
    expect(messageEnterAction({ ...base, empty: true })).toBe("none");
    expect(messageEnterAction({ ...base, shift: true })).toBe("passthrough");
    expect(messageEnterAction({ ...base, composing: true, empty: true, running: true, queued: true })).toBe("passthrough");
});

test("the placeholder says whether a message sends now, waits for the turn, or cannot go", () => {
    expect(messagePlaceholder({ phase: "attached", status: "idle" })).toBe("Message this subagent");
    expect(messagePlaceholder({ phase: "attached", status: "working" })).toBe("Queue a message for when this turn ends");
    expect(messagePlaceholder({ phase: "attaching", status: "idle" })).toBe("Opening the subagent");
    expect(messagePlaceholder({ phase: "closed", status: "idle" })).toBe("Not connected to this subagent");
});
