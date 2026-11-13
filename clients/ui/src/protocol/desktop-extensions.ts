// How the window reads installed desktop extensions from the shell. The shell never parses a manifest or runs code.

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_MAIN_BYTES = 1024 * 1024;
export const MAX_LISTED_EXTENSIONS = 200;

// One folder under the extensions directory. `text` is the raw manifest; `problem` says why it could not be read.
export interface ExtensionFolder {
    readonly directory: string;
    readonly text?: string;
    readonly problem?: string;
}

export interface ExtensionListing {
    readonly ok: true;
    readonly folders: readonly ExtensionFolder[];
    // True when more folders exist than are listed.
    readonly truncated: boolean;
}

export interface ExtensionFileRefusal {
    readonly ok: false;
    readonly reason: string;
}

export type ExtensionListResult = ExtensionListing | ExtensionFileRefusal;

export type ExtensionMainResult = { readonly ok: true; readonly source: string } | ExtensionFileRefusal;

export type ExtensionLogLevel = "info" | "warn" | "error";
