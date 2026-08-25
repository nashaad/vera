import {
    ADVERSARIAL_REVIEW_TIMEOUT_MS,
    AdversarialReviewInputError,
    parseAdversarialTarget,
    runAdversarialReview,
    type AdversarialReviewRequest,
    type AdversarialReviewResult,
} from "./review.ts";

interface CliOutput {
    write(text: string): unknown;
}

export interface AdversarialCliDependencies {
    readonly stdout: CliOutput;
    readonly stderr: CliOutput;
    readonly workspace?: string;
    readonly review?: (
        request: AdversarialReviewRequest,
    ) => Promise<AdversarialReviewResult>;
}

export async function runAdversarialCli(
    args: readonly string[],
    dependencies: AdversarialCliDependencies,
): Promise<number | undefined> {
    if (args[0] !== "adversarial") return undefined;

    const rest = [...args.slice(1)];
    const jsonIndex = rest.indexOf("--json");
    const json = jsonIndex !== -1;
    if (json) rest.splice(jsonIndex, 1);
    if (rest.includes("--json")) {
        dependencies.stderr.write("--json may be supplied only once\n");
        return 2;
    }

    let target;
    try {
        target = parseAdversarialTarget(rest);
    } catch (error) {
        dependencies.stderr.write(`${message(error)}\n`);
        return 2;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timeout = setTimeout(abort, ADVERSARIAL_REVIEW_TIMEOUT_MS);
    timeout.unref();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
        const result = await (dependencies.review ?? runAdversarialReview)({
            workspace: dependencies.workspace ?? process.cwd(),
            target,
            signal: controller.signal,
        });
        if (json) {
            dependencies.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.outcome === "completed") {
            dependencies.stdout.write(
                `${result.report.trim().length === 0
                    ? "Adversarial review completed with no report."
                    : result.report}\n`,
            );
        } else if (result.report.length > 0) {
            dependencies.stdout.write(`${result.report}\n`);
        }
        if (result.outcome === "completed") return 0;
        if (result.outcome === "aborted") return 130;
        if (!json && result.error !== undefined) {
            dependencies.stderr.write(`${result.error.message}\n`);
        }
        return 1;
    } catch (error) {
        dependencies.stderr.write(`${message(error)}\n`);
        if (controller.signal.aborted || isAbortError(error)) return 130;
        return error instanceof AdversarialReviewInputError ? 2 : 1;
    } finally {
        clearTimeout(timeout);
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
