import { captureBounded } from "../../src/tools/bounded-capture.ts";
import {
    Vera,
    type AgentRunResult,
} from "../../src/sdk/agent.ts";

export const ADVERSARIAL_REVIEW_PROMPT = "You are the leaf adversarial reviewer. Review only the selected git target. Do not edit files, run tests or builds, commit, push, merge, reset, stash, invoke codex exec, invoke any other agent, or request another review. Return actionable findings first, ordered P0 through P3, with precise file/line or commit references, concrete failure mechanisms, and smallest useful corrections. Separate confirmed defects from questions and suggestions. End with coverage and unverified areas.";

const MAX_PATCH_BYTES = 1_000_000;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
export const ADVERSARIAL_REVIEW_TIMEOUT_MS = 10 * 60_000;

export type AdversarialTarget =
    | { readonly kind: "uncommitted" }
    | { readonly kind: "commit"; readonly value: string }
    | { readonly kind: "base"; readonly value: string };

export interface AdversarialReviewRequest {
    readonly workspace: string;
    readonly target: AdversarialTarget;
    readonly signal?: AbortSignal;
}

export interface AdversarialReviewResult {
    readonly outcome: AgentRunResult["outcome"];
    readonly report: string;
    readonly target: AdversarialTarget;
    readonly resolvedRevision?: string;
    readonly changedFiles: string;
    readonly patchBytes: number;
    readonly model: AgentRunResult["model"];
    readonly usage?: AgentRunResult["usage"];
    readonly substitutions: AgentRunResult["substitutions"];
    readonly error?: AgentRunResult["error"];
}

export interface AdversarialReviewDependencies {
    readonly createReviewer?: (
        workspace: string,
        signal?: AbortSignal,
    ) => Promise<{
        run(
            prompt: string,
            options?: { readonly signal?: AbortSignal },
        ): Promise<AgentRunResult>;
    }>;
    readonly runGit?: typeof runGit;
}

export class AdversarialReviewInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AdversarialReviewInputError";
    }
}

export async function runAdversarialReview(
    request: AdversarialReviewRequest,
    dependencies: AdversarialReviewDependencies = {},
): Promise<AdversarialReviewResult> {
    request.signal?.throwIfAborted();
    const target = validatedTarget(request.target);
    const snapshot = await buildReviewSnapshot(
        request.workspace,
        target,
        request.signal,
        dependencies.runGit ?? runGit,
    );
    const reviewer = await (dependencies.createReviewer ?? createReviewer)(
        request.workspace,
        request.signal,
    );
    request.signal?.throwIfAborted();
    const result = await reviewer.run(snapshotPrompt(snapshot), {
        signal: request.signal,
    });
    return {
        outcome: result.outcome,
        report: result.text,
        target,
        ...(snapshot.resolvedRevision === undefined
            ? {}
            : { resolvedRevision: snapshot.resolvedRevision }),
        changedFiles: snapshot.changedFiles,
        patchBytes: snapshot.patchBytes,
        model: result.model,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        substitutions: result.substitutions,
        ...(result.error === undefined ? {} : { error: result.error }),
    };
}

function validatedTarget(target: AdversarialTarget): AdversarialTarget {
    if (target.kind === "uncommitted") {
        return parseAdversarialTarget(["--uncommitted"]);
    }
    return parseAdversarialTarget([`--${target.kind}`, target.value]);
}

export function parseAdversarialTarget(
    args: readonly string[],
): AdversarialTarget {
    if (args.length === 1 && args[0] === "--uncommitted") {
        return { kind: "uncommitted" };
    }
    if (args.length === 2 && args[0] === "--commit") {
        const value = args[1] ?? "";
        if (!/^[0-9a-fA-F]{7,64}$/.test(value)) {
            throw new AdversarialReviewInputError(
                "--commit requires a 7-64 character hexadecimal commit hash",
            );
        }
        return { kind: "commit", value };
    }
    if (args.length === 2 && args[0] === "--base") {
        const value = args[1] ?? "";
        if (
            value.length === 0
            || value.length > 512
            || value.startsWith("-")
            || /[\s\0]/.test(value)
        ) {
            throw new AdversarialReviewInputError(
                "--base requires one non-option git ref without whitespace",
            );
        }
        return { kind: "base", value };
    }
    throw new AdversarialReviewInputError(
        "usage: --uncommitted | --commit <sha> | --base <ref>",
    );
}

interface ReviewSnapshot {
    readonly label: string;
    readonly changedFiles: string;
    readonly patch: string;
    readonly patchBytes: number;
    readonly resolvedRevision?: string;
}

async function createReviewer(workspace: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const vera = await Vera.create({ workspace });
    signal?.throwIfAborted();
    return vera.agent({
        instructions: ADVERSARIAL_REVIEW_PROMPT,
        tools: "none",
    });
}

async function buildReviewSnapshot(
    workspace: string,
    target: AdversarialTarget,
    signal: AbortSignal | undefined,
    git: typeof runGit,
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
    git: typeof runGit,
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
