export function isSafeProviderId(value: string): boolean {
    return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}
