// Which included extensions config.json turns off, as the desktop shell reads it.

export interface IncludedExtensionsView {
    readonly ok: true;
    // The ids in `disabled_included_extensions`; every other included extension is on.
    readonly disabled: readonly string[];
    // Set when config.json could not be read; the list then comes from the last read that worked.
    readonly notice?: string;
}

export interface IncludedExtensionsFailure {
    readonly ok: false;
    readonly reason: string;
}

export type IncludedExtensionsResult = IncludedExtensionsView | IncludedExtensionsFailure;

export const MAX_DISABLED_INCLUDED = 256;
export const MAX_INCLUDED_ID_CHARS = 128;
