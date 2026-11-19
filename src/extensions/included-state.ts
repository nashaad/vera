// Whether an included extension is on, given config.json's `disabled_included_extensions`.
// Kept free of file access so the desktop window can share it with the host.

export function isIncludedExtensionOn(id: string, disabledIds: readonly string[]): boolean {
    return !disabledIds.includes(id);
}
