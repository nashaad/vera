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
    readonly partialOutputReplaceable?: boolean;
    readonly statusCode?: number;
    readonly providerErrorType?: string;
    readonly providerCode?: string;
    readonly providerName?: string;
    readonly providerMessage?: string;
    readonly allowance?: {
        readonly kind: "prompt_tokens" | "max_tokens";
        readonly requested: number;
        readonly available: number;
    };
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
