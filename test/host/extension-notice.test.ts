import { expect, test } from "bun:test";

import { extensionNoticeEvent } from "../../src/host/extension-notice.ts";

test("a text notice carries the extension id as its source", () => {
    expect(extensionNoticeEvent("Stopped at budget.", "vera.budget")).toEqual({
        type: "notice",
        key: "extension",
        count: 1,
        text: "Stopped at budget.",
        source: "vera.budget",
    });
});

test("a keyed notice carries facts and no text", () => {
    const event = extensionNoticeEvent({ key: "probe", facts: { calls: 3, warm: false } }, "vera.example");
    expect(event).toEqual({
        type: "notice",
        key: "probe",
        count: 1,
        source: "vera.example",
        facts: { calls: 3, warm: false },
    });
    expect("text" in event).toBe(false);
});

test("a keyed notice copies its facts into a fresh object", () => {
    const facts = { calls: 3 };
    const event = extensionNoticeEvent({ key: "probe", facts }, "vera.example");
    expect(event.facts).not.toBe(facts);
});

test("a keyed notice with a bad key is rejected", () => {
    expect(() => extensionNoticeEvent({ key: "Probe", facts: {} }, "vera.example"))
        .toThrow("Invalid notice key");
});

test("a keyed notice with bad facts is rejected", () => {
    expect(() => extensionNoticeEvent({ key: "probe", facts: { nested: { calls: 1 } } } as never, "vera.example"))
        .toThrow("Invalid notice facts");
});
