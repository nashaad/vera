import type { AgentDefinition } from "../../src/agents/definition.ts";
import type {
    SessionModelUsage,
    SessionModelUsageRow,
} from "../../src/engine/protocol.ts";
import {
    Vera,
    type AgentRunError,
    type AgentRunModelIdentity,
    type AgentRunOptions,
    type AgentRunOutcome,
    type AgentRunResult,
} from "../../src/sdk/agent.ts";
import {
    REVIEW_LENSES,
    refuter,
    type ReviewLensName,
} from "./lenses.ts";
import {
    FINDINGS_SCHEMA,
    VERDICT_SCHEMA,
    type RefutationVerdict,
    type ReviewFinding,
    type ReviewFindingsOutput,
} from "./review-schema.ts";
import {
    AdversarialReviewInputError,
    parseAdversarialTarget,
    type AdversarialReviewRequest,
    type AdversarialTarget,
} from "./review-request.ts";
import {
    prepareReview,
    type PreparedReview,
} from "./target-snapshot.ts";

export {
    AdversarialReviewInputError,
    parseAdversarialTarget,
} from "./review-request.ts";
export type {
    AdversarialReviewRequest,
    AdversarialTarget,
} from "./review-request.ts";

export const ADVERSARIAL_REVIEW_PROMPT = "You are the leaf adversarial reviewer. Review only the selected git target. Do not edit files, run tests or builds, commit, push, merge, reset, stash, invoke codex exec, invoke any other agent, or request another review. Return actionable findings first, ordered P0 through P3, with precise file/line or commit references, concrete failure mechanisms, and smallest useful corrections. Separate confirmed defects from questions and suggestions. End with coverage and unverified areas.";
export const ADVERSARIAL_REVIEW_TIMEOUT_MS = 10 * 60_000;

export interface ReviewedFinding {
    readonly lens: ReviewLensName;
    readonly finding: ReviewFinding;
    readonly verdict: RefutationVerdict;
}

export interface ReviewLensFailure {
    readonly lens: ReviewLensName;
    readonly error: AgentRunError;
}

export type ReviewRunRole = ReviewLensName | "refuter";

export interface ReviewRunRecord {
    readonly role: ReviewRunRole;
    readonly findingIndex?: number;
    readonly outcome: AgentRunOutcome;
    readonly typed: boolean;
    readonly model: AgentRunModelIdentity;
    readonly usage?: SessionModelUsage;
    readonly substitutions: AgentRunResult["substitutions"];
    readonly error?: AgentRunError;
}

export interface AdversarialReviewResult {
    readonly outcome: AgentRunOutcome;
    readonly report: string;
    readonly target: AdversarialTarget;
    readonly resolvedRevision?: string;
    readonly changedFiles: string;
    readonly patchBytes: number;
    readonly findings: readonly ReviewedFinding[];
    readonly lensFailures: readonly ReviewLensFailure[];
    readonly runs: readonly ReviewRunRecord[];
    readonly model: AgentRunModelIdentity;
    readonly usage?: SessionModelUsage;
    readonly substitutions: AgentRunResult["substitutions"];
    readonly error?: AgentRunError;
}

export interface ReviewRuntimeAgent {
    run<Output = never>(
        prompt: string,
        options?: AgentRunOptions<Output>,
    ): Promise<AgentRunResult<Output>>;
}

export interface ReviewRuntime {
    agent(definition: AgentDefinition): ReviewRuntimeAgent;
}

export interface CreateReviewRuntimeOptions {
    readonly workspace: string;
    readonly signal?: AbortSignal;
}

export interface AdversarialReviewDependencies {
    readonly prepare?: typeof prepareReview;
    readonly createRuntime?: (
        options: CreateReviewRuntimeOptions,
    ) => Promise<ReviewRuntime>;
}

interface SourcedFinding {
    readonly lens: ReviewLensName;
    readonly finding: ReviewFinding;
}

interface LensPass {
    readonly lens: ReviewLensName;
    readonly result: AgentRunResult<ReviewFindingsOutput>;
}

interface RefutationPass {
    readonly source: SourcedFinding;
    readonly result: AgentRunResult<RefutationVerdict>;
}

export async function runAdversarialReview(
    request: AdversarialReviewRequest,
    dependencies: AdversarialReviewDependencies = {},
): Promise<AdversarialReviewResult> {
    const review = await (dependencies.prepare ?? prepareReview)(request);
    const runtime = await (dependencies.createRuntime ?? createRuntime)({
        workspace: request.workspace,
        signal: request.signal,
    });
    request.signal?.throwIfAborted();

    const lensPasses = await Promise.all(
        REVIEW_LENSES.map(async (lens): Promise<LensPass> => ({
            lens: lens.name,
            result: await runtime.agent(lens.definition).run(review.prompt, {
                signal: request.signal,
                output: FINDINGS_SCHEMA,
            }),
        })),
    );
    const lensFailures = lensPasses.flatMap((pass) =>
        pass.result.outcome === "completed" && pass.result.output !== undefined
            ? []
            : [{
                lens: pass.lens,
                error: resultError(pass.result, `${pass.lens} lens failed`),
            }]
    );
    const sourced = lensPasses.flatMap((pass): readonly SourcedFinding[] =>
        pass.result.outcome === "completed" && pass.result.output !== undefined
            ? pass.result.output.findings.map((finding) => ({
                lens: pass.lens,
                finding,
            }))
            : []
    );
    const refutationPasses = await Promise.all(
        sourced.map(async (source): Promise<RefutationPass> => ({
            source,
            result: await runtime.agent(refuter).run(
                refutePrompt(source, review),
                {
                    signal: request.signal,
                    output: VERDICT_SCHEMA,
                },
            ),
        })),
    );
    const refutationFailures = refutationPasses.filter((pass) =>
        pass.result.outcome !== "completed" || pass.result.output === undefined
    );
    const findings = refutationPasses.flatMap((pass): readonly ReviewedFinding[] =>
        pass.result.outcome === "completed"
            && pass.result.output !== undefined
            && !pass.result.output.refuted
            ? [{
                lens: pass.source.lens,
                finding: pass.source.finding,
                verdict: pass.result.output,
            }]
            : []
    );
    const results: readonly AgentRunResult<unknown>[] = [
        ...lensPasses.map((pass) => pass.result),
        ...refutationPasses.map((pass) => pass.result),
    ];
    const runs: readonly ReviewRunRecord[] = [
        ...lensPasses.map((pass) => runRecord(pass.lens, pass.result)),
        ...refutationPasses.map((pass, index) =>
            runRecord("refuter", pass.result, index)
        ),
    ];
    const everyLensFailed = lensFailures.length === REVIEW_LENSES.length;
    const error = everyLensFailed
        ? {
            kind: "runtime" as const,
            message: "Every review lens failed.",
        }
        : refutationFailures.length > 0
        ? {
            kind: "runtime" as const,
            message:
                `${refutationFailures.length} finding refutation run failed.`,
        }
        : undefined;
    const first = results[0];
    if (first === undefined) {
        throw new Error("Adversarial review started no runs");
    }
    return reviewResult({
        review,
        findings,
        lensFailures,
        runs,
        results,
        model: first.model,
        error,
    });
}

interface ReviewResultInput {
    readonly review: PreparedReview;
    readonly findings: readonly ReviewedFinding[];
    readonly lensFailures: readonly ReviewLensFailure[];
    readonly runs: readonly ReviewRunRecord[];
    readonly results: readonly AgentRunResult<unknown>[];
    readonly model: AgentRunModelIdentity;
    readonly error?: AgentRunError;
}

function reviewResult(input: ReviewResultInput): AdversarialReviewResult {
    const { review } = input;
    const usage = aggregateUsage(input.results);
    return {
        outcome: input.error === undefined ? "completed" : "failed",
        report: renderReport(input.findings, input.lensFailures, input.error),
        target: review.target,
        ...(review.snapshot.resolvedRevision === undefined
            ? {}
            : { resolvedRevision: review.snapshot.resolvedRevision }),
        changedFiles: review.snapshot.changedFiles,
        patchBytes: review.snapshot.patchBytes,
        findings: input.findings,
        lensFailures: input.lensFailures,
        runs: input.runs,
        model: input.model,
        ...(usage === undefined ? {} : { usage }),
        substitutions: input.results.flatMap((result) => result.substitutions),
        ...(input.error === undefined ? {} : { error: input.error }),
    };
}

function refutePrompt(source: SourcedFinding, review: PreparedReview): string {
    return `Original task:\n${review.task}\n\nFinding from ${source.lens}:\n${JSON.stringify(source.finding)}\n\nImmutable target:\n${review.prompt}`;
}

async function createRuntime(
    options: CreateReviewRuntimeOptions,
): Promise<ReviewRuntime> {
    options.signal?.throwIfAborted();
    return Vera.create({
        workspace: options.workspace,
        posture: "readonly",
    });
}

function resultError(
    result: AgentRunResult<unknown>,
    fallback: string,
): AgentRunError {
    return result.error ?? { kind: "runtime", message: fallback };
}

function runRecord(
    role: ReviewRunRole,
    result: AgentRunResult<unknown>,
    findingIndex?: number,
): ReviewRunRecord {
    return {
        role,
        ...(findingIndex === undefined ? {} : { findingIndex }),
        outcome: result.outcome,
        typed: result.output !== undefined,
        model: result.model,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        substitutions: result.substitutions,
        ...(result.error === undefined ? {} : { error: result.error }),
    };
}

function aggregateUsage(
    results: readonly AgentRunResult<unknown>[],
): SessionModelUsage | undefined {
    const rows = new Map<string, SessionModelUsageRow>();
    for (const result of results) {
        for (const row of result.usage?.rows ?? []) {
            const key = `${row.provider}\0${row.model}`;
            const prior = rows.get(key);
            rows.set(key, {
                provider: row.provider,
                model: row.model,
                calls: (prior?.calls ?? 0) + row.calls,
                durationMs: (prior?.durationMs ?? 0) + row.durationMs,
                inputTokens: (prior?.inputTokens ?? 0) + row.inputTokens,
                outputTokens: (prior?.outputTokens ?? 0) + row.outputTokens,
                cachedInputTokens: (prior?.cachedInputTokens ?? 0)
                    + row.cachedInputTokens,
                reasoningTokens: (prior?.reasoningTokens ?? 0)
                    + row.reasoningTokens,
                totalTokens: (prior?.totalTokens ?? 0) + row.totalTokens,
                ...(row.cost === undefined && prior?.cost === undefined
                    ? {}
                    : { cost: (prior?.cost ?? 0) + (row.cost ?? 0) }),
                callsWithoutCost: (prior?.callsWithoutCost ?? 0)
                    + row.callsWithoutCost,
            });
        }
    }
    return rows.size === 0 ? undefined : { rows: [...rows.values()] };
}

function renderReport(
    findings: readonly ReviewedFinding[],
    failures: readonly ReviewLensFailure[],
    error: AgentRunError | undefined,
): string {
    const sections: string[] = [];
    if (findings.length === 0) {
        sections.push("No findings survived refutation.");
    } else {
        sections.push(findings.map((row) => {
            const location = row.finding.file === undefined
                ? ""
                : ` ${row.finding.file}${row.finding.line === undefined
                    ? ""
                    : `:${row.finding.line}`}`;
            const fix = row.finding.suggestedFix === undefined
                ? ""
                : `\nCorrection: ${row.finding.suggestedFix}`;
            return `${row.finding.severity.toUpperCase()}${location} ${row.finding.summary}\nLens: ${row.lens}\nMechanism: ${row.finding.mechanism}\nEvidence: ${row.finding.evidence}${fix}\nRefutation: ${row.verdict.reasoning}`;
        }).join("\n\n"));
    }
    if (failures.length > 0) {
        sections.push(
            `Lens failures:\n${failures.map((failure) =>
                `- ${failure.lens}: ${failure.error.message}`
            ).join("\n")}`,
        );
    }
    if (error !== undefined) sections.push(error.message);
    return sections.join("\n\n");
}
