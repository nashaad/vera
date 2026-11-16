import type { PageCapture } from "./page-captures.ts";
import type { ImportedThemeSummary } from "../theme/imported.ts";

// `imported` is empty when the person closed the file picker without choosing. `themes` is every imported theme
// after this run, `skipped` the themes of an extension package that could not be imported, with the reason.
export interface CommandThemesDone {
    readonly ok: true;
    readonly kind: "themes";
    readonly imported: readonly ImportedThemeSummary[];
    readonly themes: readonly ImportedThemeSummary[];
    readonly skipped: readonly string[];
}

// One choice of a list. `key` names it in the next run of the command until the command lists again.
export interface CommandPickItem {
    readonly key: string;
    readonly label: string;
    readonly detail?: string;
}

export interface CommandPickAnswer {
    readonly ok: true;
    readonly kind: "pick";
    readonly title: string;
    readonly items: readonly CommandPickItem[];
    // True when more items were found than are listed.
    readonly cut: boolean;
}

export interface CommandRefusal {
    readonly ok: false;
    // Phrased for the person; the current theme stays.
    readonly reason: string;
}

export interface CommandCaptureAnswer {
    readonly ok: true;
    readonly kind: "capture";
    readonly capture: PageCapture;
}

export interface CommandClosedAnswer {
    readonly ok: true;
    readonly kind: "closed";
}

export type ExtensionCommandResult = CommandThemesDone | CommandPickAnswer | CommandCaptureAnswer | CommandClosedAnswer | CommandRefusal;
