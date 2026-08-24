import { expect, test } from "bun:test";

import { runAdversarialCli } from "../../clients/cli/adversarial.ts";
import type { AdversarialReviewResult } from "../../extensions/adversarial/review.ts";

test("CLI validates before dispatch and supports text and JSON results", async () => {
    const output = sink();
    const errors = sink();
    let calls = 0;
    const review = async (): Promise<AdversarialReviewResult> => {
        calls += 1;
        return completed();
    };

    expect(await runAdversarialCli([
        "adversarial",
        "--prompt",
        "do evil",
    ], { stdout: output, stderr: errors, review })).toBe(2);
    expect(calls).toBe(0);

    expect(await runAdversarialCli([
        "adversarial",
        "--uncommitted",
    ], { stdout: output, stderr: errors, review })).toBe(0);
    expect(output.text).toContain("review\n");

    output.text = "";
    expect(await runAdversarialCli([
        "adversarial",
        "--json",
        "--base",
        "main",
    ], { stdout: output, stderr: errors, review })).toBe(0);
    expect(JSON.parse(output.text)).toMatchObject({
        outcome: "completed",
        report: "review",
    });
    expect(calls).toBe(2);
});

test("CLI distinguishes abort errors and reports an empty completion", async () => {
    const output = sink();
    const errors = sink();
    expect(await runAdversarialCli([
        "adversarial",
        "--uncommitted",
    ], {
        stdout: output,
        stderr: errors,
        review: async () => ({ ...completed(), report: "" }),
    })).toBe(0);
    expect(output.text).toContain("completed with no report");

    const abort = new Error("stopped");
    abort.name = "AbortError";
    expect(await runAdversarialCli([
        "adversarial",
        "--uncommitted",
    ], {
        stdout: output,
        stderr: errors,
        review: async () => { throw abort; },
    })).toBe(130);
});

function sink(): { text: string; write(text: string): void } {
    return {
        text: "",
        write(text) {
            this.text += text;
        },
    };
}

function completed(): AdversarialReviewResult {
    return {
        outcome: "completed",
        report: "review",
        target: { kind: "uncommitted" },
        changedFiles: "M file.ts",
        patchBytes: 12,
        model: { provider: "faux", model: "reviewer" },
        substitutions: [],
    };
}
