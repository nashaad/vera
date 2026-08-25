import { expect, test } from "bun:test";

import type { AdversarialReviewResult } from "./review.ts";
import { runAdversarialWorkflow } from "./main.ts";

test("the SDK workflow runs directly without an extension host", async () => {
    const output = sink();
    const errors = sink();
    let calls = 0;
    const result = await runAdversarialWorkflow(["--uncommitted"], {
        stdout: output,
        stderr: errors,
        workspace: "/workspace",
        review: async (request): Promise<AdversarialReviewResult> => {
            calls += 1;
            expect(request.workspace).toBe("/workspace");
            expect(request.target).toEqual({ kind: "uncommitted" });
            return completed();
        },
    });

    expect(result).toBe(0);
    expect(calls).toBe(1);
    expect(output.text).toBe("review\n");
    expect(errors.text).toBe("");
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
        findings: [],
        lensFailures: [],
        runs: [],
        model: { provider: "faux", model: "reviewer" },
        substitutions: [],
    };
}
