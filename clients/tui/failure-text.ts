import type {
    ClassifierFailure,
    ClassifierFailureKind,
    ModelFailure,
} from "../../src/engine/protocol.ts";

export interface ClassifierFailureText {
    readonly headline: string;
    readonly message: string;
    readonly fix: string;
}

export interface ModelFailureText {
    readonly message: string;
    readonly fix: string;
}

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

export function classifierFailureText(
    failure: ClassifierFailure,
    now = Date.now(),
): ClassifierFailureText {
    return {
        headline: `${failure.tool} did not run`,
        message: classifierProblem(failure, now),
        fix: classifierFix(failure),
    };
}

function classifierProblem(failure: ClassifierFailure, now: number): string {
    const classifier = failure.classifier === undefined
        ? "The classifier"
        : `The classifier, ${failure.classifier},`;
    switch (failure.kind) {
        case "no_route":
            return "No classifier model is set.";
        case "undescribed":
            return "Vera could not describe the action to the classifier.";
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

function classifierFix(failure: ClassifierFailure): string {
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

export function modelFailureText(failure: ModelFailure, now = Date.now()): ModelFailureText {
    return {
        message: modelProblem(failure, now),
        fix: modelFix(failure, now),
    };
}

function modelProblem(failure: ModelFailure, now: number): string {
    const model = `The model, ${failure.model},`;
    if (failure.kind === "rate_limit" && failure.resetsAt !== undefined) {
        return failure.resetsAt > now
            ? `${model} is out of usage until ${resetTime(failure.resetsAt, now)}.`
            : `${model} was out of usage until ${resetTime(failure.resetsAt, now)}.`;
    }
    const problem = MODEL_PROBLEMS[failure.kind];
    const said = shortDetail(failure.providerMessage);
    return said === undefined
        ? `${model} ${problem}.`
        : `${model} ${problem}: ${said}`;
}

const MODEL_PROBLEMS: Readonly<Record<ModelFailure["kind"], string>> = {
    connection: "could not be reached",
    timeout: "did not answer in time",
    rate_limit: "hit its provider's rate or usage limit",
    server: "failed with a server error",
    authentication: "rejected Vera's credentials",
    payment_required: "is out of credit",
    permission: "refused access",
    invalid_request: "rejected the request",
    not_found: "was not found",
    request_too_large: "rejected the request as too large",
    unknown: "failed",
};

function modelFix(failure: ModelFailure, now: number): string {
    switch (failure.kind) {
        case "rate_limit":
            return failure.resetsAt !== undefined && failure.resetsAt > now
                ? "wait until then, or pick a model on another provider with /model."
                : "wait a minute and send again, or pick a model on another provider with /model.";
        case "payment_required":
            return "add credit with the provider, or pick a model on another provider with /model.";
        case "authentication":
        case "permission":
            return "check the provider's API key in Configure providers (Ctrl+P), or pick another model with /model.";
        case "request_too_large":
            return "run /compact, or pick a model with a larger context with /model.";
        case "not_found":
            return "pick another model with /model.";
        case "connection":
        case "timeout":
        case "server":
            return "send again. If it keeps failing, pick another model with /model.";
        default:
            return "pick another model with /model. The Vera report in /diagnostics has the full error.";
    }
}

function resetTime(resetsAt: number, now: number): string {
    const sameDay = new Date(resetsAt).toDateString() === new Date(now).toDateString();
    return sameDay
        ? clockTime.format(resetsAt)
        : dayAndTime.format(resetsAt).replace(" at ", ", ");
}

function duration(ms: number): string {
    return ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

function shortDetail(detail: string | undefined): string | undefined {
    const line = detail?.split("\n")[0]?.trim();
    if (line === undefined || line.length === 0) return undefined;
    return line.length <= DETAIL_LIMIT ? line : `${line.slice(0, DETAIL_LIMIT - 1)}…`;
}
