import type { ImportedThemeSummary } from "../theme/imported.ts";

// One desktop extension, installed or included with the app.
export interface DesktopExtensionEntry {
    readonly id: string;
    readonly version: string;
    // The labels of the themes it contributes.
    readonly themes: readonly string[];
    readonly hasMain: boolean;
    readonly hasCommands: boolean;
    // Included extensions are always on and cannot be removed.
    readonly included: boolean;
    readonly enabled: boolean;
}

// What an unpacked package holds, shown before it is installed.
export interface ExtensionPreview {
    // Names this package in `installExtension` and `cancelExtension` until the next install starts.
    readonly token: string;
    readonly id: string;
    readonly version: string;
    readonly themes: readonly string[];
    readonly hasMain: boolean;
    readonly hasCommands: boolean;
    // The installed version this package would replace.
    readonly replaces?: string;
}

export interface ExtensionsState {
    readonly extensions: readonly DesktopExtensionEntry[];
    // Every theme of an enabled extension, ready for the theme picker.
    readonly themes: readonly ImportedThemeSummary[];
}

export interface ExtensionRefusal {
    readonly ok: false;
    // Phrased for the person.
    readonly reason: string;
}

// `preview` is undefined when the person closed the file picker without choosing.
export type ExtensionPreviewResult =
    | { readonly ok: true; readonly preview: ExtensionPreview | undefined }
    | ExtensionRefusal;

export type ExtensionChangeResult = ({ readonly ok: true } & ExtensionsState) | ExtensionRefusal;
