import type { PermissionInspection } from "../../src/engine/permissions.ts";
import { tuiPermissionModeDescription } from "./settings-picker.ts";

export function renderPermissionInspection(
    inspection: PermissionInspection,
): string {
    const mode = inspection.selected;
    const preferences = inspection.activePreferences ?? [];
    const grants = inspection.activeGrants;
    const description = tuiPermissionModeDescription(mode.name);
    return [
        `Permission mode: ${mode.name}`,
        description ?? `everything unmatched: ${mode.defaultOutcome}`,
        `${count(grants.length, "session grant")} · ${
            count(preferences.length, "preference")
        }`,
        ...(grants.length === 0 && preferences.length === 0
            ? []
            : ["/settings to review or remove them"]),
    ].join("\n");
}

function count(total: number, noun: string): string {
    return `${total} ${noun}${total === 1 ? "" : "s"}`;
}
