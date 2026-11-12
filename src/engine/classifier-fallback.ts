import {
    classifierFix,
    classifierProblem,
    type ClassifierFailureFacts,
} from "../model/classifier-failure-text.ts";

// One sentence saying why the classifier could not decide, one saying what to
// change. The approval prompt shows both as its reason.
export function classifierFallbackReason(
    failure: ClassifierFailureFacts,
    now = Date.now(),
): string {
    const problem = classifierProblem(failure, now).replace(/\.$/, "");
    return `${problem}, so Vera is asking you instead. Fix: ${classifierFix(failure)}`;
}
