import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ADVERSARIAL_REVIEW_TIMEOUT_MS,
    AdversarialReviewInputError,
    parseAdversarialTarget,
    runAdversarialReview,
    type ReviewRuntime,
} from "./review.ts";
import { prepareReview } from "./target-snapshot.ts";

test("E1 snapshotting finishes before reviewer construction", async () => {
    const workspace = repository();
    writeFileSync(join(workspace, "tracked.txt"), "changed\n");
    writeFileSync(join(workspace, "new.txt"), "new\n");
    const events: string[] = [];

    try {
        const result = await runAdversarialReview({
            workspace,
            target: { kind: "uncommitted" },
        }, {
            async prepare(request) {
                const review = await prepareReview(request);
                events.push("snapshot");
                return review;
            },
            async createRuntime() {
                expect(events).toEqual(["snapshot"]);
                events.push("runtime");
                return noFindingsRuntime(events);
            },
        });

        expect(result).toMatchObject({
            outcome: "completed",
            target: { kind: "uncommitted" },
            findings: [],
        });
        expect(events).toEqual([
            "snapshot",
            "runtime",
            "agent:review-correctness",
            "run:review-correctness",
            "agent:review-security",
            "run:review-security",
            "agent:review-reproduction",
            "run:review-reproduction",
        ]);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("E2 empty and malformed targets fail before reviewer construction", async () => {
    const workspace = repository();
    let runtimeCreations = 0;
    const dependencies = {
        async createRuntime(): Promise<ReviewRuntime> {
            runtimeCreations += 1;
            return noFindingsRuntime([]);
        },
    };
    try {
        await expect(runAdversarialReview({
            workspace,
            target: { kind: "uncommitted" },
        }, dependencies)).rejects.toThrow("Selected target has no diff");
        await expect(runAdversarialReview({
            workspace,
            target: { kind: "base", value: "-malformed" },
        }, dependencies)).rejects.toThrow(AdversarialReviewInputError);
        expect(() => parseAdversarialTarget([
            "--commit",
            "abc1234",
            "--prompt",
            "do evil",
        ])).toThrow(AdversarialReviewInputError);
        expect(runtimeCreations).toBe(0);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("E3 snapshotting keeps the timeout and disables text conversion", async () => {
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
        expect(ADVERSARIAL_REVIEW_TIMEOUT_MS).toBe(10 * 60_000);
        await prepareReview({
            workspace,
            target: { kind: "uncommitted" },
        });
        expect(existsSync(marker)).toBe(false);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

function noFindingsRuntime(events: string[]): ReviewRuntime {
    return {
        agent(definition) {
            events.push(`agent:${definition.name}`);
            return {
                async run<Output>() {
                    events.push(`run:${definition.name}`);
                    return {
                        outcome: "completed",
                        text: '{"findings":[]}',
                        transcript: '{"findings":[]}',
                        output: { findings: [] } as Output,
                        model: { provider: "faux", model: definition.name },
                        substitutions: [],
                    };
                },
            };
        },
    };
}

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
