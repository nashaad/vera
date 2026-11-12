import type {
    ClassifierFailure,
    ModelFailure,
} from "../../src/engine/protocol.ts";
import {
    classifierFix,
    classifierProblem,
    resetTime,
    shortDetail,
} from "../../src/model/classifier-failure-text.ts";

export interface ClassifierFailureText {
    readonly headline: string;
    readonly message: string;
    readonly fix: string;
}

export interface ModelFailureText {
    readonly message: string;
    readonly fix: string;
}

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

export function modelFailureText(failure: ModelFailure, now = Date.now()): ModelFailureText {
    return {
        message: modelProblem(failure, now),
        fix: modelFix(failure, now),
    };
}

function modelProblem(failure: ModelFailure, now: number): string {
    if (failure.kind === "request_build") {
        return `Vera could not build the request for ${failure.model}.`;
    }
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

const MODEL_PROBLEMS: Readonly<Record<Exclude<ModelFailure["kind"], "request_build">, string>> = {
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
        case "request_build":
            return "open /diagnostics and check the Vera report.";
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
