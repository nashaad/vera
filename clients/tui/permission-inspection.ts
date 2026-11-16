import type {
    PermissionInspection,
    PermissionRule,
} from "../../src/engine/permissions.ts";
import { sandboxInspectionLine } from "../../src/sandbox/inspection.ts";
import { tuiPermissionModeDescription } from "./settings-picker.ts";

export function renderPermissionInspection(
    inspection: PermissionInspection,
): string {
    const mode = inspection.selected;
    const preferences = inspection.activePreferences ?? [];
    const grants = inspection.activeGrants;
    const description = tuiPermissionModeDescription(mode.name);
    const userRules = inspection.userRules ?? [];
    return [
        `Permission mode: ${mode.name}`,
        sandboxInspectionLine(inspection.sandbox, mode.name),
        ...(userRules.length === 0
            ? []
            : [
                "Your rules (permission_rules):",
                ...userRules.map((rule) => `  ${describeRule(rule)}`),
            ]),
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

function describeRule(rule: PermissionRule): string {
    const when = Object.entries(rule.when)
        .map(([field, value]) => `${field} ${String(value)}`)
        .join(", ");
    return `${rule.then} ${when.length === 0 ? "any action" : when} (${rule.name})`;
}
