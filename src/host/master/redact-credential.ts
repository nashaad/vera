import { ProviderFailureError, type ProviderFailure } from "../../model/provider-failure.ts";
import { UserFacingError } from "../../user-facing-error.ts";

export function redactCredentialValues(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === "string") {
        return secrets.filter((secret) => secret.length > 0)
            .reduce((text, secret) => text.split(secret).join("[redacted]"), value);
    }
    if (value instanceof ProviderFailureError) {
        const failure = redactCredentialValues(value.failure, secrets) as ProviderFailure;
        return new ProviderFailureError(failure, undefined);
    }
    if (value instanceof Error) {
        const message = redactCredentialValues(value.message, secrets) as string;
        const error = value instanceof UserFacingError ? new UserFacingError(message) : new Error(message);
        error.name = value.name;
        return error;
    }
    if (Array.isArray(value)) return value.map((entry) => redactCredentialValues(entry, secrets));
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactCredentialValues(entry, secrets)]));
}

export function storedCredentialSecrets(token: string): readonly string[] {
    try {
        const value: unknown = JSON.parse(token);
        if (typeof value !== "object" || value === null) return [token];
        const record = value as Record<string, unknown>;
        return [record.access_token, record.refresh_token, record.access, record.refresh]
            .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    } catch {
        return [token];
    }
}
