import { describe, expect, test } from "bun:test";

import type { ImportedSessionSummary } from "../../src/host/agent-registry/support.ts";
import { withImportRows } from "../../clients/tui/import-rows.ts";
import type { TuiTranscriptEntry } from "../../clients/tui/state.ts";

const facts: ImportedSessionSummary = {
    tool: "claude-code",
    source_session_id: "src-1",
    source_started_at: "2026-09-02T10:00:00.000Z",
    message_count: 2,
    last_message_id: "m2",
};

const imported: TuiTranscriptEntry[] = [
    { kind: "user", text: "hello", entryId: "m1" },
    { kind: "assistant", text: "hi there", entryId: "m2#0" },
];

function texts(entries: readonly TuiTranscriptEntry[]): string[] {
    return entries.map((entry) => `${entry.kind}:${"text" in entry ? entry.text : ""}`);
}

describe("withImportRows", () => {
    test("adds a banner and labels imported replies with the source tool", () => {
        expect(texts(withImportRows(imported, facts))).toEqual([
            "worked:imported from Claude Code · 2 messages · Sep 2, 2026",
            "user:hello",
            "extension_label:Claude Code",
            "assistant:hi there",
        ]);
    });

    test("marks where Vera takes over once a Vera turn follows", () => {
        const entries = [
            ...imported,
            { kind: "user", text: "next", entryId: "m3" },
            { kind: "assistant", text: "vera reply", entryId: "m4" },
        ] satisfies TuiTranscriptEntry[];
        expect(texts(withImportRows(entries, facts)).slice(4)).toEqual([
            "worked:continued in Vera",
            "user:next",
            "assistant:vera reply",
        ]);
    });

    test("a notice after the imported turns is not a Vera turn", () => {
        const entries = [
            ...imported,
            { kind: "notice", text: "Type /back to return" },
        ] satisfies TuiTranscriptEntry[];
        expect(texts(withImportRows(entries, facts))).not.toContain("worked:continued in Vera");
    });

    test("returns the same array when the rows are already in place", () => {
        const once = withImportRows(imported, facts);
        expect(withImportRows(once, facts)).toBe(once);
        const grown = withImportRows([...once, { kind: "user", text: "more" }], facts);
        expect(withImportRows(grown, facts)).toBe(grown);
        expect(texts(grown).filter((line) => line === "worked:continued in Vera")).toHaveLength(1);
    });

    test("shows only the banner when the boundary message is not present", () => {
        const branched: TuiTranscriptEntry[] = [
            { kind: "user", text: "hello", entryId: "b1" },
            { kind: "assistant", text: "hi there", entryId: "b2" },
        ];
        expect(texts(withImportRows(branched, facts))).toEqual([
            "worked:imported from Claude Code · 2 messages · Sep 2, 2026",
            "user:hello",
            "assistant:hi there",
        ]);
    });

    test("removes the rows when the session is not an import", () => {
        const once = withImportRows(imported, facts);
        expect(withImportRows(once, undefined)).toEqual(imported);
        expect(withImportRows(imported, undefined)).toBe(imported);
    });
});
