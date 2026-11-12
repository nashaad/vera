// Switches the desktop reads from a file in its own directory under the home. None has a control in the window.
export interface DesktopFlags {
    // Shows the model's reasoning in the transcript.
    readonly showReasoning: boolean;
}

export const DEFAULT_DESKTOP_FLAGS: DesktopFlags = { showReasoning: false };

// Only a boolean `true` turns a flag on; a missing, misspelled or mistyped field keeps its default.
export function parseFlags(value: unknown): DesktopFlags {
    if (typeof value !== "object" || value === null) return DEFAULT_DESKTOP_FLAGS;
    const fields = value as Record<string, unknown>;
    return { showReasoning: fields.showReasoning === true };
}
