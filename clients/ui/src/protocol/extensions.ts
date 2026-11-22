import type { ImportedThemeSummary } from "../theme/imported.ts";

// A command the window can run. The palette lists it as `<category>: <title>`, or the title alone.
export interface DesktopCommandEntry {
    readonly id: string;
    readonly title: string;
    readonly category?: string;
}

// A command shown in one place; the title is the entry's own or else the command's.
export interface DesktopMenuItem {
    readonly command: string;
    readonly title: string;
    readonly description?: string;
    readonly button?: string;
    readonly icon?: "pointer";
    readonly page?: true;
}

export interface DesktopWorkerCommand {
    readonly command: string;
    readonly title: string;
    readonly category?: string;
    readonly when?: string;
}

export interface DesktopWorkerKeybinding {
    readonly command: string;
    readonly key: string;
    readonly mac?: string;
    readonly when?: string;
}

export interface DesktopWorkerContribution {
    readonly main: string;
    readonly commands: readonly DesktopWorkerCommand[];
    readonly keybindings: readonly DesktopWorkerKeybinding[];
}

export interface DesktopExtensionDiagnostic {
    readonly directory: string;
    readonly problem: string;
}

export interface DesktopExtensionMenus {
    // Rows in Settings > Appearance.
    readonly appearance: readonly DesktopMenuItem[];
    // Items in the app menu's Theme submenu.
    readonly theme: readonly DesktopMenuItem[];
    readonly browser: readonly DesktopMenuItem[];
}

// One desktop extension, installed or included with the app.
export interface DesktopExtensionEntry {
    readonly id: string;
    readonly version: string;
    // The labels of the themes it contributes.
    readonly themes: readonly string[];
    readonly hasMain: boolean;
    readonly hasCommands: boolean;
    readonly hasUnavailableContributions: boolean;
    // Worker contributions exist only for enabled installed extensions.
    readonly worker?: DesktopWorkerContribution;
    // Only the commands this window can run, which are those of included extensions that name a task.
    readonly commands: readonly DesktopCommandEntry[];
    readonly menus: DesktopExtensionMenus;
    readonly filePreviews?: readonly string[];
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
    readonly hasUnavailableContributions: boolean;
    // The installed version this package would replace.
    readonly replaces?: string;
}

export interface ExtensionsState {
    readonly extensions: readonly DesktopExtensionEntry[];
    // Every theme of an enabled extension, ready for the theme picker.
    readonly themes: readonly ImportedThemeSummary[];
    // Invalid folders omitted from the extension list, capped at 200 entries.
    readonly diagnostics?: readonly DesktopExtensionDiagnostic[];
    readonly listingProblem?: string;
    readonly truncated?: boolean;
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

export type ExtensionChangeResult = ({ readonly ok: true; readonly replacedId?: string } & ExtensionsState) | ExtensionRefusal;
