export type AdversarialTarget =
    | { readonly kind: "uncommitted" }
    | { readonly kind: "commit"; readonly value: string }
    | { readonly kind: "base"; readonly value: string };

export interface AdversarialReviewRequest {
    readonly workspace: string;
    readonly target: AdversarialTarget;
    readonly task?: string;
    readonly signal?: AbortSignal;
}

export class AdversarialReviewInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AdversarialReviewInputError";
    }
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

export function validateAdversarialTarget(
    target: AdversarialTarget,
): AdversarialTarget {
    if (target.kind === "uncommitted") {
        return parseAdversarialTarget(["--uncommitted"]);
    }
    return parseAdversarialTarget([`--${target.kind}`, target.value]);
}
