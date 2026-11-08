import { ProviderFailureError } from "./provider-failure.ts";

export function requestBuildFailure(cause: unknown): ProviderFailureError {
    if (cause instanceof ProviderFailureError && cause.failure.kind === "request_build") {
        return cause;
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    const message = detail.trim().length === 0 ? "Request build failed" : detail;
    return new ProviderFailureError({
        kind: "request_build",
        resolution: "none",
        message,
    }, cause);
}

export function buildModelRequest<T>(build: () => T): T {
    try {
        return build();
    } catch (cause) {
        throw requestBuildFailure(cause);
    }
}
