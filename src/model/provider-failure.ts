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
    /** Provider-neutral error category returned by a routing service. */
    readonly providerErrorType?: string;
    /** Upstream provider's own error code, when the router exposes it. */
    readonly providerCode?: string;
    /** Upstream provider name, when a routing service exposes it. */
    readonly providerName?: string;
    /** Upstream provider's parsed error message, never its raw response body. */
    readonly providerMessage?: string;
    /** Provider-reported request allowance at the time this call was refused. */
    readonly allowance?: {
        readonly kind: "prompt_tokens" | "max_tokens";
        readonly requested: number;
        readonly available: number;
    };
    /** Concrete next action suitable for a client to present verbatim. */
    readonly userAction?: string;
}

export class ProviderFailureError extends Error {
    readonly failure: ProviderFailure;

    constructor(failure: ProviderFailure, cause: unknown) {
        super(failure.message, { cause });
        this.name = "ProviderFailureError";
        this.failure = failure;
    }
}
