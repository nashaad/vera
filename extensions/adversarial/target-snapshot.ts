import { captureBounded } from "../../src/tools/bounded-capture.ts";
import {
    AdversarialReviewInputError,
    validateAdversarialTarget,
    type AdversarialReviewRequest,
    type AdversarialTarget,
} from "./review-request.ts";

const MAX_PATCH_BYTES = 1_000_000;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
const DEFAULT_REVIEW_TASK = "Review the selected Git target for defects.";

export interface ReviewSnapshot {
    readonly label: string;
    readonly changedFiles: string;
    readonly patch: string;
    readonly patchBytes: number;
    readonly resolvedRevision?: string;
}

export interface PreparedReview {
    readonly target: AdversarialTarget;
    readonly snapshot: ReviewSnapshot;
    readonly task: string;
    readonly prompt: string;
}

export async function prepareReview(
    request: AdversarialReviewRequest,
    git: RunGit = runGit,
): Promise<PreparedReview> {
    request.signal?.throwIfAborted();
    const target = validateAdversarialTarget(request.target);
    const snapshot = await captureReviewSnapshot(
        request.workspace,
        target,
        request.signal,
        git,
    );
    return {
        target,
        snapshot,
        task: normalizedTask(request.task),
        prompt: snapshotPrompt(snapshot),
    };
}

export async function captureReviewSnapshot(
    workspace: string,
    target: AdversarialTarget,
    signal: AbortSignal | undefined,
    git: RunGit = runGit,
): Promise<ReviewSnapshot> {
    if (target.kind === "uncommitted") {
        const [tracked, status, untracked] = await Promise.all([
            git(
                workspace,
                ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"],
                signal,
            ),
            git(workspace, ["status", "--short"], signal),
            git(
                workspace,
                ["ls-files", "--others", "--exclude-standard", "-z"],
                signal,
            ),
        ]);
        let patch = tracked.stdout;
        for (const path of untracked.stdout.split("\0").filter(Boolean)) {
            const remaining = MAX_PATCH_BYTES - Buffer.byteLength(patch);
            if (remaining <= 0) patchTooLarge();
            const added = await git(
                workspace,
                [
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--binary",
                    "--",
                    "/dev/null",
                    path,
                ],
                signal,
                [0, 1],
                remaining + 1,
            );
            patch += added.stdout;
        }
        return snapshot("uncommitted", status.stdout, patch);
    }

    const revision = await resolveRevision(workspace, target, signal, git);
    if (target.kind === "commit") {
        const [patch, files] = await Promise.all([
            git(
                workspace,
                [
                    "show",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--format=fuller",
                    "--binary",
                    revision,
                ],
                signal,
            ),
            git(
                workspace,
                [
                    "show",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--format=",
                    "--name-status",
                    revision,
                ],
                signal,
            ),
        ]);
        return snapshot(
            `commit ${target.value} (${revision})`,
            files.stdout,
            patch.stdout,
            revision,
        );
    }

    const range = `${revision}...HEAD`;
    const [patch, files] = await Promise.all([
        git(
            workspace,
            ["diff", "--no-ext-diff", "--no-textconv", "--binary", range],
            signal,
        ),
        git(
            workspace,
            ["diff", "--no-ext-diff", "--no-textconv", "--name-status", range],
            signal,
        ),
    ]);
    return snapshot(
        `base ${target.value} (${revision})`,
        files.stdout,
        patch.stdout,
        revision,
    );
}

async function resolveRevision(
    workspace: string,
    target: Exclude<AdversarialTarget, { readonly kind: "uncommitted" }>,
    signal: AbortSignal | undefined,
    git: RunGit,
): Promise<string> {
    const resolved = await git(
        workspace,
        ["rev-parse", "--verify", `${target.value}^{commit}`],
        signal,
    );
    const revision = resolved.stdout.trim();
    if (!/^[0-9a-fA-F]{40,64}$/.test(revision)) {
        throw new Error(`Git returned an invalid revision for ${target.value}`);
    }
    return revision;
}

function snapshot(
    label: string,
    changedFiles: string,
    patch: string,
    resolvedRevision?: string,
): ReviewSnapshot {
    const patchBytes = Buffer.byteLength(patch);
    if (patchBytes === 0) {
        throw new AdversarialReviewInputError("Selected target has no diff");
    }
    if (patchBytes > MAX_PATCH_BYTES) patchTooLarge();
    return {
        label,
        changedFiles: changedFiles.trim() || "(metadata unavailable)",
        patch,
        patchBytes,
        ...(resolvedRevision === undefined ? {} : { resolvedRevision }),
    };
}

function snapshotPrompt(snapshot: ReviewSnapshot): string {
    return `Selected target: ${snapshot.label}\n\nChanged files:\n${snapshot.changedFiles}\n\nPatch:\n${snapshot.patch}`;
}

function normalizedTask(task: string | undefined): string {
    const normalized = task?.trim();
    return normalized === undefined || normalized.length === 0
        ? DEFAULT_REVIEW_TASK
        : normalized;
}

function patchTooLarge(): never {
    throw new AdversarialReviewInputError(
        `Selected diff is larger than ${MAX_PATCH_BYTES.toLocaleString()} bytes`,
    );
}

interface GitResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

async function runGit(
    workspace: string,
    args: readonly string[],
    signal?: AbortSignal,
    allowedExitCodes: readonly number[] = [0],
    stdoutLimit = MAX_PATCH_BYTES + 1,
): Promise<GitResult> {
    signal?.throwIfAborted();
    const process = Bun.spawn([
        "git",
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=",
        "-c",
        "diff.external=",
        ...args,
    ], {
        cwd: workspace,
        env: sanitizedGitEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
        signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        captureBounded(process.stdout, stdoutLimit, "git stdout"),
        captureBounded(process.stderr, MAX_GIT_ERROR_BYTES, "git stderr"),
        process.exited,
    ]);
    signal?.throwIfAborted();
    if (!allowedExitCodes.includes(exitCode)) {
        throw new Error(
            stderr.text.trim()
                || `git ${args[0] ?? "command"} exited with code ${exitCode}`,
        );
    }
    if (stdout.truncated) patchTooLarge();
    return { stdout: stdout.text, stderr: stderr.text, exitCode };
}

function sanitizedGitEnvironment(): Record<string, string | undefined> {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    return {
        ...environment,
        GIT_EXTERNAL_DIFF: "",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
    };
}

export type RunGit = typeof runGit;
