// Desktop extension main-module reads and runtime logs use the desktop shell.

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_MAIN_BYTES = 1024 * 1024;

// One folder under the extensions directory. `text` is the raw manifest; `problem` says why it could not be read.
export interface ExtensionFolder {
    readonly directory: string;
    readonly text?: string;
    readonly problem?: string;
}

export interface ExtensionFileRefusal {
    readonly ok: false;
    readonly reason: string;
}

export type ExtensionMainResult = { readonly ok: true; readonly source: string } | ExtensionFileRefusal;

export type ExtensionLogLevel = "info" | "warn" | "error";
