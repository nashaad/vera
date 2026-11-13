const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_MODEL_CHARS = 256;

export function providerArgument(value: unknown): string | undefined {
    return typeof value === "string" && PROVIDER_PATTERN.test(value) ? value : undefined;
}

export function modelArgument(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_CHARS ? value : undefined;
}
