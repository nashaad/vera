import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReviewLogger } from "../../src/engine/review-log.ts";

function entry() {
    return {
        tier: "single" as const,
        outcome: "decided" as const,
        tool: "bash",
        toolInput: { command: "ls" },
        workspace: "/workspace",
        routingReason: "This command may access a path outside the workspace.",
        model: "review-model",
        systemPrompt: "harness",
        prompt: "proposed action",
        transcriptTurns: 2,
        continuedConversation: false,
        decision: "allow",
        latencyMs: 12,
    };
}

test("the review log appends one readable line per call", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-review-log-")), "r.jsonl");
    const log = createReviewLogger({
        path,
        now: () => new Date("2026-08-08T00:00:00.000Z"),
    });

    log(entry());
    log({ ...entry(), decision: "deny" });

    const lines = (await Bun.file(path).text()).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe("tool_review");
    expect(first.timestamp).toBe("2026-08-08T00:00:00.000Z");
    expect(first.tool).toBe("bash");
    expect(first.prompt).toBe("proposed action");
    expect(JSON.parse(lines[1]!).decision).toBe("deny");
});

test("the review log file is readable only by its owner", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-review-log-")), "r.jsonl");

    createReviewLogger({ path })(entry());

    expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("an unwritable path loses the record rather than the review", () => {
    const log = createReviewLogger({ path: "/dev/null/nested/r.jsonl" });

    expect(() => log(entry())).not.toThrow();
});
