import type { VeraExtensionApi } from "../../src/sdk/extensions.ts";
import {
    AdversarialReviewInputError,
    parseAdversarialTarget,
    runAdversarialReview,
    type AdversarialTarget,
} from "./review.ts";

const REVIEW_TIMEOUT_MS = 10 * 60_000;

export interface AdversarialExtensionDependencies {
    readonly review?: typeof runAdversarialReview;
}

export function activate(
    vera: VeraExtensionApi,
    dependencies: AdversarialExtensionDependencies = {},
): void {
    const review = dependencies.review ?? runAdversarialReview;
    vera.commands.register({
        name: "adversarial",
        description: "Run a bounded adversarial review of a git target",
        usage: "/adversarial --uncommitted | --commit <sha> | --base <ref>",
        timeoutMs: REVIEW_TIMEOUT_MS,
        async run({ argumentsText, workspace, signal }) {
            try {
                const target = parseAdversarialTarget(words(argumentsText));
                const result = await review({
                    workspace,
                    target,
                    signal,
                });
                return result.outcome === "completed"
                    ? { kind: "text", text: result.report }
                    : {
                        kind: "notice",
                        level: "error",
                        text: result.error?.message
                            ?? `Adversarial review ${result.outcome}`,
                    };
            } catch (error) {
                return {
                    kind: "notice",
                    level: "error",
                    text: message(error),
                };
            }
        },
    });

    vera.tools.register({
        name: "adversarial_review",
        description: "Run a read-only adversarial review of exactly one git target.",
        invocation: "top_level",
        permissionOperation: "adversarial.review",
        timeoutMs: REVIEW_TIMEOUT_MS,
        inputSchema: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: ["uncommitted", "commit", "base"],
                },
                value: { type: "string" },
            },
            required: ["target"],
            additionalProperties: false,
        },
        async run({ input, workspace, signal }) {
            try {
                const target = toolTarget(input);
                const result = await review({
                    workspace,
                    target,
                    signal,
                });
                return {
                    output: result.outcome === "completed"
                        ? result.report
                        : result.error?.message
                            ?? `Adversarial review ${result.outcome}`,
                    isError: result.outcome !== "completed",
                };
            } catch (error) {
                return { output: message(error), isError: true };
            }
        },
    });
}

function words(value: string): readonly string[] {
    const trimmed = value.trim();
    return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

function toolTarget(input: Readonly<Record<string, unknown>>): AdversarialTarget {
    if (input.target === "uncommitted" && input.value === undefined) {
        return { kind: "uncommitted" };
    }
    if (
        (input.target === "commit" || input.target === "base")
        && typeof input.value === "string"
    ) {
        return parseAdversarialTarget([`--${input.target}`, input.value]);
    }
    throw new AdversarialReviewInputError(
        "target uncommitted takes no value; commit and base require one value",
    );
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
