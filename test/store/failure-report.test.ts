import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    failureReportConsultInput,
    failureReportMarkdown,
    sanitizeReportText,
    writeFailureReport,
} from "../../src/store/failure-report.ts";
import type { ModelFailureRecord } from "../../src/store/model-failures.ts";

const HOME = "/Users/someone";

function record(
    overrides: Partial<ModelFailureRecord> = {},
): ModelFailureRecord {
    return {
        at: "2026-08-19T10:00:00.000Z",
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        kind: "no_visible_response",
        detail: "Model returned no visible response or structured tool call.",
        sessionId: "session-a",
        ...overrides,
    };
}

test("the home directory becomes a tilde", () => {
    expect(sanitizeReportText(`read ${HOME}/Projects/thing.ts`, HOME))
        .toBe("read ~/Projects/thing.ts");
});

test("another machine's user directory loses the user", () => {
    const scrubbed = sanitizeReportText("/home/priya/notes.md", HOME);
    expect(scrubbed).not.toContain("priya");
    expect(scrubbed).toBe("/home/[redacted-user]/notes.md");
});

test("an email address is removed", () => {
    expect(sanitizeReportText("account ada@example.com is over quota", HOME))
        .toBe("account [redacted-email] is over quota");
});

test("a url keeps its host and loses its query and user", () => {
    const scrubbed = sanitizeReportText(
        "POST https://ada:hunter2@api.example.com/v1/chat?key=abcd1234",
        HOME,
    );
    expect(scrubbed).toContain("api.example.com/v1/chat");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).not.toContain("abcd1234");
});

// The credential rules the diagnostics scrubber already owns still apply
// here, because a report is the text most likely to be handed to a stranger.
test("credential shapes are still removed", () => {
    const scrubbed = sanitizeReportText(
        "authorization: Bearer live-token; api_key=sk-example12345678",
        HOME,
    );
    expect(scrubbed).not.toContain("live-token");
    expect(scrubbed).not.toContain("sk-example");
});

test("the report names each signature with its count and last error", () => {
    const markdown = failureReportMarkdown({
        records: [record(), record({ sessionId: "session-b" })],
        at: new Date("2026-08-19T12:00:00.000Z"),
        home: HOME,
    });
    expect(markdown).toContain("# Vera model failure report");
    expect(markdown).toContain("### openrouter/moonshotai/kimi-k3");
    expect(markdown).toContain("- count: 2 across 2 sessions");
    expect(markdown).toContain("Model returned no visible response");
});

test("a model's summary is scrubbed like everything else", () => {
    const markdown = failureReportMarkdown({
        records: [record()],
        at: new Date("2026-08-19T12:00:00.000Z"),
        home: HOME,
        summary: `the model failed while reading ${HOME}/secrets, mail ada@example.com`,
    });
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("~/secrets");
    expect(markdown).not.toContain(HOME);
    expect(markdown).not.toContain("ada@example.com");
});

// The same scrubbing has to happen before the text reaches a model, not only
// before it reaches the file.
test("the text sent to a model carries no paths, mail, or session ids", () => {
    const input = failureReportConsultInput([
        record({
            detail: `failed reading ${HOME}/notes for ada@example.com`,
            sessionId: "session-secret",
        }),
    ], HOME);
    expect(input).toContain("model: openrouter/moonshotai/kimi-k3");
    expect(input).toContain("~/notes");
    expect(input).not.toContain(HOME);
    expect(input).not.toContain("ada@example.com");
    expect(input).not.toContain("session-secret");
});

test("the report is written owner-only under a named directory", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "vera-report-")), "reports");
    const at = new Date("2026-08-19T12:00:00.000Z");
    const path = writeFailureReport(directory, "# report\n", at);
    expect(path).toBe(join(directory, "failures-2026-08-19T12-00-00-000Z.md"));
    expect(readFileSync(path, "utf8")).toBe("# report\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
});
