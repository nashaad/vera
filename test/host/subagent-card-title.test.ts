import { expect, test } from "bun:test";

import { childTitleOf } from "../../clients/ui/src/session/subagentCards.ts";
import { listedTitle } from "../../src/host/agent-registry/session-title.ts";
import type { SessionMessageEntry } from "../../src/store/session-store.ts";

// The desktop matches a blocking subagent call to its child by the title the host lists for the child.
test("@core the title the desktop derives from a description is the title the host lists for it", () => {
    const texts = [
        "Count the doubloons in the hold",
        "  spaced\n\tout   text  ",
        "x".repeat(200),
        `${"word ".repeat(15)}tail end of a long prompt`,
        `${"a".repeat(79)} b`,
        `${"a".repeat(79)}  b`,
        "   ",
        "",
    ];
    for (const text of texts) {
        const entry = {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: "2026-11-16T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text }] },
        } as unknown as SessionMessageEntry;
        expect(childTitleOf(text)).toBe(listedTitle(undefined, entry)?.trim());
    }
});
