import type { ClassifierFailure, ClassifierFailureKind } from "./types.ts";

// Classifier failure wording shared by the engine fallback and the TUI error row.

export type ClassifierFailureFacts = Omit<ClassifierFailure, "tool">;

const DETAIL_LIMIT = 160;

const clockTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
});

const dayAndTime = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

// The whole account is refused, so another model on the same provider fails the same way.
const ACCOUNT_KINDS: ReadonlySet<ClassifierFailureKind> = new Set([
    "rate_limit",
    "payment_required",
    "authentication",
    "permission",
]);

export function classifierProblem(
    failure: ClassifierFailureFacts,
    now = Date.now(),
): string {
    const classifier = failure.classifier === undefined
        ? "The classifier"
        : `The classifier, ${failure.classifier},`;
    switch (failure.kind) {
        case "no_route":
            return "No classifier model is set.";
        case "undescribed":
            return "Vera could not describe the action to the classifier.";
        case "request_build":
            return `Vera could not build the request for ${failure.classifier ?? "the classifier"}.`;
        case "unreadable":
            return `${classifier} gave an answer Vera could not read.`;
        case "timeout":
            return failure.timeoutMs === undefined
                ? `${classifier} did not answer in time.`
                : `${classifier} did not answer within ${duration(failure.timeoutMs)}.`;
        case "rate_limit":
            if (failure.resetsAt === undefined) {
                return `${classifier} hit its provider's rate or usage limit.`;
            }
            return failure.resetsAt > now
                ? `${classifier} is out of usage until ${resetTime(failure.resetsAt, now)}.`
                : `${classifier} was out of usage until ${resetTime(failure.resetsAt, now)}.`;
        case "payment_required":
            return `${classifier} is out of credit.`;
        default: {
            const detail = shortDetail(failure.detail);
            return detail === undefined
                ? `${classifier} failed.`
                : `${classifier} failed: ${detail}`;
        }
    }
}

export function classifierFix(failure: ClassifierFailureFacts): string {
    if (failure.kind === "no_route") {
        return "open /settings, then Classifier, and pick a model.";
    }
    if (failure.kind === "undescribed") {
        return "ask Vera to try the action again.";
    }
    if (failure.kind === "rate_limit" && failure.resetsAt === undefined) {
        return "wait a minute and send again, or open /settings, then Classifier, and pick a model on another provider.";
    }
    return ACCOUNT_KINDS.has(failure.kind)
        ? "open /settings, then Classifier, and pick a model on another provider, or set a failsafe there."
        : "open /settings, then Classifier, and pick another model, or set a failsafe there.";
}

export function resetTime(resetsAt: number, now: number): string {
    const sameDay = new Date(resetsAt).toDateString() === new Date(now).toDateString();
    return sameDay
        ? clockTime.format(resetsAt)
        : dayAndTime.format(resetsAt).replace(" at ", ", ");
}

function duration(ms: number): string {
    return ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

export function shortDetail(detail: string | undefined): string | undefined {
    const line = detail?.split("\n")[0]?.trim();
    if (line === undefined || line.length === 0) return undefined;
    return line.length <= DETAIL_LIMIT ? line : `${line.slice(0, DETAIL_LIMIT - 1)}…`;
}
