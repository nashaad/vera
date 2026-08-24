import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AdversarialReviewInputError,
    parseAdversarialTarget,
    runAdversarialReview,
} from "./review.ts";
import type { AgentRunResult } from "../../src/sdk/agent.ts";

test("workflow snapshots one target before constructing its reviewer", async () => {
    const workspace = repository();
    writeFileSync(join(workspace, "tracked.txt"), "changed\n");
    writeFileSync(join(workspace, "new.txt"), "new\n");
    let calls = 0;
    let prompt = "";

    try {
        const result = await runAdversarialReview({
            workspace,
            target: { kind: "uncommitted" },
        }, {
            async createReviewer() {
                calls += 1;
                return {
                    async run(input): Promise<AgentRunResult> {
                        prompt = input;
                        return completed("P2 finding");
                    },
                };
            },
        });

        expect(calls).toBe(1);
        expect(result).toMatchObject({
            outcome: "completed",
            report: "P2 finding",
            target: { kind: "uncommitted" },
        });
        expect(prompt).toContain("Selected target: uncommitted");
        expect(prompt).toContain("tracked.txt");
        expect(prompt).toContain("new.txt");
        expect(prompt).toContain("Patch:");
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("empty and malformed targets fail before a reviewer is created", async () => {
    const workspace = repository();
    let calls = 0;
    try {
        await expect(runAdversarialReview({
            workspace,
            target: { kind: "uncommitted" },
        }, {
            async createReviewer() {
                calls += 1;
                return { run: async () => completed("unused") };
            },
        })).rejects.toThrow("Selected target has no diff");
        expect(calls).toBe(0);
        expect(() => parseAdversarialTarget([
            "--commit",
            "abc1234",
            "--prompt",
            "do evil",
        ])).toThrow(AdversarialReviewInputError);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("snapshotting disables repository-configured text conversion", async () => {
    const workspace = repository();
    const marker = join(workspace, "textconv-ran");
    const driver = join(workspace, "textconv.sh");
    writeFileSync(
        driver,
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat "$1"\n`,
    );
    chmodSync(driver, 0o755);
    writeFileSync(join(workspace, ".gitattributes"), "*.txt diff=hostile\n");
    git(workspace, ["config", "diff.hostile.textconv", driver]);
    git(workspace, ["add", ".gitattributes"]);
    git(workspace, ["commit", "-qm", "attributes"]);
    writeFileSync(join(workspace, "tracked.txt"), "changed\n");

    try {
        await runAdversarialReview({
            workspace,
            target: { kind: "uncommitted" },
        }, {
            createReviewer: async () => ({
                run: async () => completed("review"),
            }),
        });
        expect(existsSync(marker)).toBe(false);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

function repository(): string {
    const workspace = mkdtempSync(join(tmpdir(), "vera-adversarial-test-"));
    git(workspace, ["init", "-q"]);
    git(workspace, ["config", "user.name", "Test"]);
    git(workspace, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(workspace, "tracked.txt"), "initial\n");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-qm", "initial"]);
    return workspace;
}

function git(workspace: string, args: readonly string[]): void {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: workspace,
        stdout: "ignore",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString());
    }
}

function completed(text: string): AgentRunResult {
    return {
        outcome: "completed",
        text,
        model: { provider: "faux", model: "reviewer" },
        substitutions: [],
    };
}
