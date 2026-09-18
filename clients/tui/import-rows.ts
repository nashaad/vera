import type { ImportedSessionSummary } from "../../src/host/agent-registry/support.ts";
import { importToolLabel } from "../../src/store/session-import-provenance.ts";
import {
    transcriptMessageId,
    type TuiTextTranscriptEntry,
    type TuiTranscriptEntry,
} from "./state.ts";

const startedDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
});

export function importBannerText(imported: ImportedSessionSummary): string {
    const started = new Date(imported.source_started_at);
    const count = imported.message_count === 1
        ? "1 message"
        : `${imported.message_count} messages`;
    const parts = [`imported from ${importToolLabel(imported.tool)}`, count];
    if (!Number.isNaN(started.getTime())) parts.push(startedDate.format(started));
    return parts.join(" · ");
}

export const CONTINUED_IN_VERA_TEXT = "continued in Vera";

// Returns `entries` itself when the import rows are already in place, so a
// render only rebuilds after history loads or the first Vera turn starts.
export function withImportRows(
    entries: readonly TuiTranscriptEntry[],
    imported: ImportedSessionSummary | undefined,
): readonly TuiTranscriptEntry[] {
    const plain = entries.filter((entry) => !isImportRow(entry));
    if (imported === undefined || plain.length === 0) {
        return plain.length === entries.length ? entries : plain;
    }
    const expected = importRows(plain, imported);
    return sameEntries(entries, expected) ? entries : expected;
}

function importRows(
    entries: readonly TuiTranscriptEntry[],
    imported: ImportedSessionSummary,
): TuiTranscriptEntry[] {
    // A branch copies messages under new ids, so its boundary is not found.
    const boundary = entries.findLastIndex((entry) =>
        "entryId" in entry
        && transcriptMessageId(entry.entryId) === imported.last_message_id
    );
    const veraTurnFollows = entries.slice(boundary + 1)
        .some((entry) => entry.kind === "user" || entry.kind === "assistant");
    const label = importToolLabel(imported.tool);
    const rows: TuiTranscriptEntry[] = [
        importRow("worked", importBannerText(imported)),
    ];
    for (const [index, entry] of entries.entries()) {
        if (index <= boundary && entry.kind === "assistant") {
            rows.push(importRow("extension_label", label));
        }
        rows.push(entry);
        if (index === boundary && veraTurnFollows) {
            rows.push(importRow("worked", CONTINUED_IN_VERA_TEXT));
        }
    }
    return rows;
}

function importRow(
    kind: "worked" | "extension_label",
    text: string,
): TuiTextTranscriptEntry {
    return { kind, text, importRow: true };
}

function isImportRow(entry: TuiTranscriptEntry): boolean {
    return "importRow" in entry && entry.importRow === true;
}

function sameEntries(
    current: readonly TuiTranscriptEntry[],
    expected: readonly TuiTranscriptEntry[],
): boolean {
    if (current.length !== expected.length) return false;
    for (const [index, entry] of expected.entries()) {
        const existing = current[index]!;
        if (isImportRow(entry)
            ? !isImportRow(existing)
                || existing.kind !== entry.kind
                || ("text" in existing && "text" in entry && existing.text !== entry.text)
            : existing !== entry) {
            return false;
        }
    }
    return true;
}
