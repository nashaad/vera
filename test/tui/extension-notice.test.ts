import { expect, test } from "bun:test";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    renderedExtensionNotice,
    type TuiNoticeRenderer,
} from "../../clients/tui/extension-notice.ts";

const render: TuiNoticeRenderer = (source, notice) =>
    `${source} ${notice.key} ${notice.facts.calls}`;

test("a text notice and a non-notice update pass through unchanged", () => {
    const text: AgentUpdate = { type: "notice", key: "inbox", count: 2, text: "hi", seq: 3 };
    const other: AgentUpdate = { type: "prompt_withdrawn", requestId: "r", content: "c", seq: 4 };

    expect(renderedExtensionNotice(text, undefined)).toBe(text);
    expect(renderedExtensionNotice(other, render)).toBe(other);
});

test("@core a facts notice becomes a text notice keyed extension", () => {
    const update: AgentUpdate = {
        type: "notice",
        key: "cache_miss",
        count: 1,
        source: "vera.cache",
        facts: { calls: 20 },
        seq: 7,
    };

    expect(renderedExtensionNotice(update, render)).toEqual({
        type: "notice",
        key: "extension",
        count: 1,
        text: "vera.cache cache_miss 20",
        source: "vera.cache",
        seq: 7,
    });
});

test("a facts notice is dropped without a renderer, a source, or a rendered line", () => {
    const withSource: AgentUpdate = {
        type: "notice",
        key: "cache_miss",
        count: 1,
        source: "vera.cache",
        facts: { calls: 20 },
        seq: 7,
    };
    const withoutSource: AgentUpdate = {
        type: "notice",
        key: "cache_miss",
        count: 1,
        facts: { calls: 20 },
        seq: 7,
    };

    expect(renderedExtensionNotice(withSource, undefined)).toBeUndefined();
    expect(renderedExtensionNotice(withoutSource, render)).toBeUndefined();
    expect(renderedExtensionNotice(withSource, () => undefined)).toBeUndefined();
});
