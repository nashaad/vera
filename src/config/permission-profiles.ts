import { migratePermissionPredicate } from "../engine/permission-compat.ts";
import {
    CORE_PERMISSION_OPERATIONS,
    type PermissionOutcome,
    type PermissionPredicate,
    type PermissionProfile,
    type PermissionRule,
} from "../engine/permissions.ts";

const OUTCOMES = new Set<PermissionOutcome>([
    "allow",
    "review",
    "ask",
    "deny",
]);

const PREDICATE_FIELDS = new Set([
    "tool",
    "verb",
    "operation",
    "path",
    "scope",
    "executable",
    // Legacy claim-shaped fields, accepted only when they can be migrated
    // without changing what the rule matches. See permission-compat.ts.
    "capability",
    "path_scope",
]);

export function parsePermissionProfiles(
    value: unknown,
    reviewerProfiles: Readonly<Record<string, unknown>>,
): Readonly<Record<string, PermissionProfile>> | undefined {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        return undefined;
    }

    const profiles: Record<string, PermissionProfile> = {};
    for (const [name, profileValue] of Object.entries(value)) {
        const profile = parsePermissionProfile(
            name,
            profileValue,
            reviewerProfiles,
        );
        if (
            profile === undefined
            || profiles[name] !== undefined
            || name === "ask"
            || name === "auto"
            || name === "full_access"
        ) {
            return undefined;
        }
        profiles[name] = profile;
    }
    return profiles;
}

function parsePermissionProfile(
    name: string,
    value: unknown,
    reviewerProfiles: Readonly<Record<string, unknown>>,
): PermissionProfile | undefined {
    if (!isConfigName(name) || !isRecord(value)) {
        return undefined;
    }
    const defaultOutcome = value.default;
    const reviewerProfile = value.reviewer_profile;
    const rulesValue = value.rules;
    if (
        !isOutcome(defaultOutcome)
        || !Array.isArray(rulesValue)
        || (reviewerProfile !== undefined
            && (typeof reviewerProfile !== "string"
                || reviewerProfiles[reviewerProfile] === undefined))
    ) {
        return undefined;
    }

    const rules: PermissionRule[] = [];
    for (let index = 0; index < rulesValue.length; index += 1) {
        const rule = parsePermissionRule(name, index, rulesValue[index]);
        if (rule === undefined) {
            return undefined;
        }
        rules.push(rule);
    }
    const canReview = defaultOutcome === "review"
        || rules.some((rule) => rule.then === "review");
    if (canReview !== (reviewerProfile !== undefined)) {
        return undefined;
    }
    return {
        name,
        rules,
        defaultOutcome,
        ...(reviewerProfile === undefined
            ? {}
            : { reviewerProfile }),
    };
}

function parsePermissionRule(
    profileName: string,
    index: number,
    value: unknown,
): PermissionRule | undefined {
    if (!isRecord(value) || !isOutcome(value.then)) {
        return undefined;
    }
    const when = parsePredicate(value.when);
    if (when === undefined) {
        return undefined;
    }
    return {
        name: `${profileName}.rules.${index}`,
        when,
        then: value.then,
    };
}

function parsePredicate(value: unknown): PermissionPredicate | undefined {
    if (
        !isRecord(value)
        || Object.keys(value).length === 0
        || Object.keys(value).some((field) => !PREDICATE_FIELDS.has(field))
    ) {
        return undefined;
    }
    const predicate = migratePermissionPredicate(value);
    if (
        predicate === undefined
        || (predicate.operation !== undefined
            && !validOperationPattern(predicate.operation))
    ) {
        return undefined;
    }
    return predicate;
}

function validOperationPattern(pattern: string): boolean {
    if (!pattern.endsWith("*")) {
        return CORE_PERMISSION_OPERATIONS.has(pattern);
    }
    const prefix = pattern.slice(0, -1);
    return prefix.length > 0
        && [...CORE_PERMISSION_OPERATIONS].some((operation) =>
            operation.startsWith(prefix)
        );
}

function isOutcome(value: unknown): value is PermissionOutcome {
    return OUTCOMES.has(value as PermissionOutcome);
}

function isConfigName(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
