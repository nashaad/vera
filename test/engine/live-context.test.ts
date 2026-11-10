import { expect, test } from "bun:test";

import { dropMessagesBehindLiveContext } from "../../src/engine/live-context.ts";
import type { ModelMessage } from "../../src/model/types.ts";

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

test("messages behind the live branch are dropped", () => {
    const [first, second, third] = [user("ahoy"), user("hoist"), user("plunder")];
    const held = [first, second, third];
    dropMessagesBehindLiveContext(held, { messages: () => [second, third] });
    expect(held).toEqual([second, third]);
    expect(held[0]).toBe(second);
});

test("an empty live branch keeps everything held", () => {
    const pending = [user("ahoy"), user("not stored yet")];
    dropMessagesBehindLiveContext(pending, { messages: () => [] });
    expect(pending).toHaveLength(2);
});

test("a held tail that differs from the live branch is left alone", () => {
    const [first, second, third] = [user("ahoy"), user("hoist"), user("plunder")];
    const held = [first, second, user("unstored crow")];
    dropMessagesBehindLiveContext(held, { messages: () => [second, third] });
    expect(held).toHaveLength(3);
    const reordered = [first, third, second];
    dropMessagesBehindLiveContext(reordered, { messages: () => [second, third] });
    expect(reordered).toHaveLength(3);
});
