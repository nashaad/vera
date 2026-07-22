import { expect, test } from "bun:test";

import { PromptPrefixTracker } from "../../src/engine/prompt-prefix-drift.ts";
import type { PromptContributionMetadata } from "../../src/engine/prompt-contributions.ts";

test("stable prefix drift identifies changed contributions and owners", () => {
    const tracker = new PromptPrefixTracker();

    expect(tracker.observe([
        contribution("core.identity", "stable", 0, "a"),
        contribution("core.tools", "stable", 1, "b"),
        contribution("core.date", "contextual", 2, "c"),
    ])).toBeUndefined();
    expect(tracker.observe([
        contribution("core.tools", "stable", 0, "changed"),
        contribution("core.workspace", "stable", 1, "d"),
        contribution("core.date", "contextual", 2, "new-date"),
    ])).toEqual({
        cause: "unexplained",
        changes: [
            {
                id: "core.identity",
                owner: "core",
                kind: "removed",
                previousOrder: 0,
            },
            {
                id: "core.tools",
                owner: "core",
                kind: "content_changed",
                previousOrder: 1,
                currentOrder: 0,
            },
            {
                id: "core.workspace",
                owner: "core",
                kind: "added",
                currentOrder: 1,
            },
        ],
    });
});

test("stable prefix drift reports relative reordering without insertion noise", () => {
    const tracker = new PromptPrefixTracker();
    tracker.observe([
        contribution("core.identity", "stable", 0, "a"),
        contribution("core.tools", "stable", 1, "b"),
    ]);

    expect(tracker.observe([
        contribution("core.tools", "stable", 0, "b"),
        contribution("core.identity", "stable", 1, "a"),
    ])).toEqual({
        cause: "unexplained",
        changes: [
            {
                id: "core.identity",
                owner: "core",
                kind: "reordered",
                previousOrder: 0,
                currentOrder: 1,
            },
            {
                id: "core.tools",
                owner: "core",
                kind: "reordered",
                previousOrder: 1,
                currentOrder: 0,
            },
        ],
    });
});

test("contextual changes do not count as stable prefix drift", () => {
    const tracker = new PromptPrefixTracker();
    tracker.observe([
        contribution("core.identity", "stable", 0, "same"),
        contribution("core.date", "contextual", 1, "first"),
    ]);

    expect(tracker.observe([
        contribution("core.identity", "stable", 0, "same"),
        contribution("core.date", "contextual", 1, "second"),
    ])).toBeUndefined();
});

function contribution(
    id: string,
    target: "stable" | "contextual",
    order: number,
    sha256: string,
): PromptContributionMetadata {
    return {
        id,
        owner: "core",
        target,
        order,
        bytes: sha256.length,
        sha256,
    };
}
