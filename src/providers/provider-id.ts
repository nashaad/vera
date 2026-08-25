/**
 * Provider ids become config keys, model prefixes, and catalog filenames.
 * Keeping them to one lowercase slug prevents those identities from changing
 * meaning when they cross a filesystem or protocol boundary.
 */
export function isSafeProviderId(value: string): boolean {
    return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}
