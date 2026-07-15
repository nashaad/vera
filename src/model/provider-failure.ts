export type ProviderFailureKind =
    | "connection"
    | "timeout"
    | "rate_limit"
    | "server"
    | "authentication"
    | "payment_required"
    | "permission"
    | "invalid_request"
    | "not_found"
    | "request_too_large"
    | "unknown";

export type ProviderFailureResolution = "retry" | "user_action" | "none";

export interface ProviderFailure {
    readonly kind: ProviderFailureKind;
    readonly resolution: ProviderFailureResolution;
    readonly message: string;
    readonly statusCode?: number;
}

export class ProviderFailureError extends Error {
    readonly failure: ProviderFailure;

    constructor(failure: ProviderFailure, cause: unknown) {
        super(failure.message, { cause });
        this.name = "ProviderFailureError";
        this.failure = failure;
    }
}
