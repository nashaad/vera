import { expect, test } from "bun:test";
import { parseColor, TextAttributes, type CapturedSpan } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { classifierFailureText } from "../../clients/tui/failure-text.ts";
import { resolveTuiDiagnostic } from "../../clients/tui/diagnostic-severity.ts";
import { createTuiErrorRow, updateTuiErrorRow } from "../../clients/tui/error-row.ts";
import {
    TUI_DANGER,
    TUI_TEXT,
    tuiEntryIsErrorRow,
    type TuiTranscriptEntry,
} from "../../clients/tui/state.ts";

const afternoon = new Date(2026, 9, 15, 14, 0).getTime();
const text = classifierFailureText({
    tool: "write",
    classifier: "openai-codex/gpt-6-luna",
    kind: "rate_limit",
    resetsAt: new Date(2026, 9, 15, 18, 35).getTime(),
}, afternoon);
const classifierEntry: TuiTranscriptEntry = {
    kind: "notice",
    text: "",
    diagnostic: resolveTuiDiagnostic("classifier_failed", text.message, {
        headline: text.headline,
        fix: text.fix,
    }),
};

function spanWith(spans: readonly CapturedSpan[], needle: string): CapturedSpan | undefined {
    return spans.find((span) => span.text.includes(needle));
}

test("an error row leads with a bold red title and hangs wrapped lines under it", async () => {
    const setup = await createTestRenderer({ width: 48, height: 10 });
    const row = createTuiErrorRow(setup.renderer, "error", classifierEntry, 0);
    setup.renderer.root.add(row);

    try {
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
        expect(lines.slice(0, 7)).toEqual([
            "× CLASSIFIER FAILED · write did not run",
            "  The classifier, openai-codex/gpt-6-luna, is",
            "  out of usage until 6:35 PM.",
            "  Fix: open /settings, then Classifier, and",
            "  pick a model on another provider, or set a",
            "  failsafe there.",
            "",
        ]);

        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        const marker = spanWith(spans, "×");
        const title = spanWith(spans, "CLASSIFIER FAILED");
        const body = spanWith(spans, "The classifier");
        const fix = spanWith(spans, "Fix:");
        expect(marker?.fg).toEqual(parseColor(TUI_DANGER));
        expect(title?.fg).toEqual(parseColor(TUI_DANGER));
        expect((title?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
        expect(body?.fg).toEqual(parseColor(TUI_TEXT));
        expect((body?.attributes ?? 0) & TextAttributes.BOLD).toBe(0);
        expect((fix?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    } finally {
        setup.renderer.destroy();
    }
});

test("a repeated error counts on the title line", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    const entry: TuiTranscriptEntry = {
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic("model_request_failed", "rate limited after retries"),
    };
    const row = createTuiErrorRow(setup.renderer, "error", entry, 0);
    setup.renderer.root.add(row);

    try {
        updateTuiErrorRow(row, { ...entry, repeat: 3 });
        await setup.flush();
        const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
        expect(lines.slice(0, 2)).toEqual([
            "× MODEL REQUEST FAILED (×3)",
            "  rate limited after retries",
        ]);
    } finally {
        setup.renderer.destroy();
    }
});

test("only standalone errors take the error row", () => {
    expect(tuiEntryIsErrorRow(classifierEntry)).toBe(true);
    expect(tuiEntryIsErrorRow({
        kind: "notice",
        text: "",
        diagnostic: resolveTuiDiagnostic("turn_interrupted", "Interrupted"),
    })).toBe(false);
    expect(tuiEntryIsErrorRow({
        kind: "notice",
        text: "Verifying crow-main",
        diagnostic: resolveTuiDiagnostic("unknown", "The model did not answer."),
    })).toBe(false);
    expect(tuiEntryIsErrorRow({ kind: "notice", text: "Saved the map" })).toBe(false);
});
