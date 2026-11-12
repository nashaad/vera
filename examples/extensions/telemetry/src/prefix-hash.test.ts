import { describe, expect, test } from "bun:test";

import { PrefixSessions, canonical, prefixChanged, prefixParts } from "./prefix-hash.ts";

const MESSAGES = [
    { role: "user", content: [{ type: "text", text: "sail east" }] },
    { role: "assistant", content: [{ type: "text", text: "aye" }] },
];

function parts(overrides: Partial<Parameters<typeof prefixParts>[0]> = {}) {
    return prefixParts({ systemPrompt: "plot a course", tools: [{ name: "read" }], messages: MESSAGES, ...overrides });
}

describe("canonical", () => {
    test("sorts object keys and skips undefined entries", () => {
        expect(canonical({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    });

    test("keeps array order, which the request order depends on", () => {
        expect(canonical([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
    });

    test("hashes image bytes instead of writing them out", () => {
        const text = canonical({ type: "image", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" });
        expect(text).not.toContain("[1,2,3]");
        expect(text).toMatch(/"\$bytes":"[0-9a-f]{64}"/);
    });
});

describe("prefixParts", () => {
    test("makes twelve hex characters per hash", () => {
        const hashes = parts();
        for (const hash of [hashes.system, hashes.tools, ...hashes.messages]) {
            expect(hash).toMatch(/^[0-9a-f]{12}$/);
        }
    });

    test("hashes only the first four messages", () => {
        const many = Array.from({ length: 9 }, (_, index) => ({ role: "user", content: String(index) }));
        expect(parts({ messages: many }).messages).toHaveLength(4);
    });

    test("is stable when a value moves between otherwise equal requests", () => {
        expect(parts().system).toBe(parts().system);
        expect(parts({ systemPrompt: "other" }).system).not.toBe(parts().system);
    });
});

describe("prefixChanged", () => {
    test("no previous call is not a change", () => {
        expect(prefixChanged(undefined, parts())).toBeNull();
    });

    test("the same request is not a change", () => {
        expect(prefixChanged(parts(), parts())).toBeNull();
    });

    test("system is reported before everything else", () => {
        expect(prefixChanged(parts(), parts({ systemPrompt: "new orders", tools: [{ name: "write" }] }))).toBe("system");
    });

    test("tools are compared in request order", () => {
        const changed = parts({ tools: [{ name: "write" }, { name: "read" }] });
        expect(prefixChanged(parts(), changed)).toBe("tools");
    });

    test("names the first message that differs", () => {
        const messages = [MESSAGES[0], MESSAGES[1], { role: "user", content: "third" }, { role: "assistant", content: "fourth" }];
        const before = parts({ messages });
        const after = parts({
            messages: [messages[0], messages[1], { role: "user", content: "changed" }, messages[3]],
        });
        expect(prefixChanged(before, after)).toBe("message:2");
    });

    test("a longer conversation keeps its prefix", () => {
        const before = parts();
        const after = parts({ messages: [...MESSAGES, { role: "user", content: "and north" }] });
        expect(prefixChanged(before, after)).toBeNull();
    });

    test("a shorter conversation that keeps the start is a change at the cut", () => {
        const before = parts({
            messages: [...MESSAGES, { role: "user", content: "third" }, { role: "assistant", content: "fourth" }],
        });
        expect(prefixChanged(before, parts())).toBe("message:2");
    });

    test("different image bytes change the message", () => {
        const one = parts({ messages: [{ role: "user", content: [{ type: "image", data: new Uint8Array([1]) }] }] });
        const two = parts({ messages: [{ role: "user", content: [{ type: "image", data: new Uint8Array([2]) }] }] });
        expect(prefixChanged(one, two)).toBe("message:0");
    });
});

describe("PrefixSessions", () => {
    test("keeps one previous prefix per session", () => {
        const sessions = new PrefixSessions();
        expect(sessions.changed("a", parts())).toBeNull();
        expect(sessions.changed("b", parts())).toBeNull();
        expect(sessions.changed("a", parts({ systemPrompt: "new" }))).toBe("system");
    });

    test("evicts the least recently used session", () => {
        const sessions = new PrefixSessions(1);
        expect(sessions.changed("a", parts())).toBeNull();
        expect(sessions.changed("b", parts())).toBeNull();
        expect(sessions.changed("a", parts())).toBeNull();
    });
});
