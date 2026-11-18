import { expect, test } from "bun:test";
import { hasSessionCloseWork } from "../../clients/tui/session-lifecycle.ts";

test("@core a close requires a running turn, compaction, or pending request", () => {
    expect(hasSessionCloseWork({ working: false, compactingSince: undefined }, false)).toBe(false);
    expect(hasSessionCloseWork({ working: true, compactingSince: undefined }, false)).toBe(true);
    expect(hasSessionCloseWork({ working: false, compactingSince: 1 }, false)).toBe(true);
    expect(hasSessionCloseWork({ working: false, compactingSince: undefined }, true)).toBe(true);
});
