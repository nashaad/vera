import type { PermissionInspection } from "../../src/engine/permissions.ts";
import { tuiPermissionModeDescription } from "./settings-picker.ts";

/**
 * A summary, not a dump. Anything shown here reads as something the user can
 * change, so this lists only what a surface can act on.
 *
 * The mode's rules are the clearest case: there are a dozen of them, none
 * editable from any client, and printing them invites the user to look for a way
 * to change one. They are replaced by the mode's own one-line description, which
 * says what the mode does without implying its internals are yours to edit. The
 * default outcome and reviewer profile are dropped for the same reason.
 *
 * Grants and preferences stay, as counts, because they are editable, and the
 * pointer says where. Zero counts are still shown: the point is that these two
 * tiers exist and are yours, which is worth knowing before you have used them.
 */
export function renderPermissionInspection(
    inspection: PermissionInspection,
): string {
    const mode = inspection.selected;
    const preferences = inspection.activePreferences ?? [];
    const grants = inspection.activeGrants;
    const description = tuiPermissionModeDescription(mode.name);
    return [
        `Permission mode: ${mode.name}`,
        // A custom mode has no written description, so fall back to the one fact
        // about it that is always true and always relevant.
        description ?? `everything unmatched: ${mode.defaultOutcome}`,
        `${count(grants.length, "session grant")} · ${
            count(preferences.length, "preference")
        }`,
        ...(grants.length === 0 && preferences.length === 0
            ? []
            // `/settings`, not the overlay's own name: granted permissions now
            // live under Permissions inside the settings menu, and pointing at
            // the menu teaches the route the user can find again.
            : ["/settings to review or remove them"]),
    ].join("\n");
}

function count(total: number, noun: string): string {
    return `${total} ${noun}${total === 1 ? "" : "s"}`;
}
