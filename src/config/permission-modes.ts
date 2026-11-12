import { CORE_PERMISSION_OPERATIONS } from "../engine/permission-operations.ts";
import { migratePermissionPredicate } from "../engine/permission-compat.ts";
import { configProblem, expectedValue, isPlainObject, keyValue } from "./diagnostic.ts";
import {
    type PermissionMode,
    type PermissionOutcome,
    type PermissionPredicate,
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
    "path_glob",
    "host",
    "scope",
    "executable",
    "capability",
    "path_scope",
]);

export function parsePermissionModes(
    value: unknown,
    reviewerProfiles: Readonly<Record<string, unknown>>,
): Readonly<Record<string, PermissionMode>> | undefined {
    if (value === undefined) {
        return {};
    }
    if (!isPlainObject(value)) {
        return configProblem("permission_modes", expectedValue("an object", value));
    }

    const modes: Record<string, PermissionMode> = {};
    for (const [name, modeValue] of Object.entries(value)) {
        if (name === "ask" || name === "auto" || name === "full_access") {
            return configProblem(
                `permission_modes.${name}`,
                "is a built-in mode and cannot be redefined",
            );
        }
        const mode = parsePermissionMode(
            name,
            modeValue,
            reviewerProfiles,
        );
        if (mode === undefined) {
            return undefined;
        }
        modes[name] = mode;
    }
    return modes;
}

function parsePermissionMode(
    name: string,
    value: unknown,
    reviewerProfiles: Readonly<Record<string, unknown>>,
): PermissionMode | undefined {
    const field = `permission_modes.${name}`;
    if (!isConfigName(name)) {
        return configProblem(
            "permission_modes",
            `mode name ${JSON.stringify(name)} must use lowercase letters, digits, - and _`,
        );
    }
    if (!isPlainObject(value)) {
        return configProblem(field, expectedValue("an object", value));
    }
    const defaultOutcome = value.default;
    const reviewerProfile = value.reviewer_profile;
    const rulesValue = value.rules;
    if (!isOutcome(defaultOutcome)) {
        return configProblem(
            field,
            keyValue("default", "allow, review, ask or deny", defaultOutcome),
        );
    }
    if (!Array.isArray(rulesValue)) {
        return configProblem(field, keyValue("rules", "a list of rules", rulesValue));
    }
    if (
        reviewerProfile !== undefined
        && (typeof reviewerProfile !== "string"
            || reviewerProfiles[reviewerProfile] === undefined)
    ) {
        return configProblem(
            field,
            keyValue("reviewer_profile", "a name in reviewer_profiles", reviewerProfile),
        );
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
    if (canReview && reviewerProfile === undefined) {
        return configProblem(
            field,
            "can review an action, so it needs a reviewer_profile",
        );
    }
    if (!canReview && reviewerProfile !== undefined) {
        return configProblem(
            field,
            "has a reviewer_profile but nothing in it ends in review",
        );
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
    modeName: string,
    index: number,
    value: unknown,
): PermissionRule | undefined {
    const field = `permission_modes.${modeName}.rules[${index}]`;
    if (!isPlainObject(value)) {
        return configProblem(field, expectedValue("an object", value));
    }
    if (!isOutcome(value.then)) {
        return configProblem(field, keyValue("then", "allow, review, ask or deny", value.then));
    }
    const when = parsePredicate(value.when, field);
    if (when === undefined) {
        return undefined;
    }
    return {
        name: `${modeName}.rules.${index}`,
        when,
        then: value.then,
    };
}

function parsePredicate(
    value: unknown,
    ruleField: string,
): PermissionPredicate | undefined {
    const field = `${ruleField}.when`;
    if (!isPlainObject(value) || Object.keys(value).length === 0) {
        return configProblem(field, expectedValue("an object with at least one key", value));
    }
    const unknownKey = Object.keys(value).find((key) => !PREDICATE_FIELDS.has(key));
    if (unknownKey !== undefined) {
        return configProblem(
            field,
            `${JSON.stringify(unknownKey)} is not a predicate key; expected ${[...PREDICATE_FIELDS].join(", ")}`,
        );
    }
    const predicate = migratePermissionPredicate(value);
    if (predicate === undefined) {
        return configProblem(field, "is not a valid predicate");
    }
    if (
        predicate.operation !== undefined
        && !validOperationPattern(predicate.operation)
    ) {
        return configProblem(
            field,
            `operation ${JSON.stringify(predicate.operation)} is not a known operation`,
        );
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
