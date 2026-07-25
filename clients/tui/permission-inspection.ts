import type {
    PermissionInspection,
    PermissionPredicate,
} from "../../src/engine/permissions.ts";

export function renderPermissionInspection(
    inspection: PermissionInspection,
): string {
    const profile = inspection.selected;
    const preferences = inspection.activePreferences ?? [];
    return [
        `Permission profile: ${profile.name}`,
        `Default: ${profile.defaultOutcome}`,
        ...(profile.reviewerProfile === undefined
            ? []
            : [`Reviewer: ${profile.reviewerProfile}`]),
        "Rules:",
        ...(profile.rules.length === 0
            ? ["  (none)"]
            : profile.rules.map((rule) =>
                `  ${rule.name}: ${formatPredicate(rule.when)} -> ${rule.then}`
            )),
        "Session grants:",
        ...(inspection.activeGrants.length === 0
            ? ["  (none)"]
            : inspection.activeGrants.map((grant) =>
                `  ${grant.id} [${grant.kind}]: ${formatPredicate(grant.when)}`
            )),
        "Preferences:",
        ...(preferences.length === 0
            ? ["  (none)"]
            : preferences.map((preference) =>
                `  ${preference.id}: ${formatPredicate(preference.when)}`
            )),
    ].join("\n");
}

function formatPredicate(predicate: PermissionPredicate): string {
    return Object.entries(predicate)
        .map(([field, value]) => `${field}=${String(value)}`)
        .join(", ");
}
