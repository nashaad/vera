/**
 * Reads permission data written before the model was simplified (claims with
 * `capability`, `confidence`, `pathScope`, `recursive`).
 *
 * Migrated:  capability -> verb, pathScope/path_scope -> scope,
 *            kind "capability" -> kind "action".
 * Rejected:  confidence, recursive, and capability execute/network, because
 *            dropping them would widen what the predicate matches.
 *
 * Callers decide what rejection means: config parsing fails loudly, session
 * grants are dropped.
 */

import {
    isPermissionGrantKind,
    isPermissionPredicate,
    type PermissionGrant,
    type PermissionGrantKind,
} from "./permission-grants.ts";
import type { PermissionPredicate } from "./permissions.ts";

const MIGRATABLE_VERBS = new Set(["read", "write", "delete", "unknown"]);

const UNMIGRATABLE_FIELDS = ["confidence", "recursive"] as const;

const RENAMED_FIELDS = new Map([
    ["capability", "verb"],
    ["pathScope", "scope"],
    ["path_scope", "scope"],
    // Not a legacy rename like the others: config JSON is snake_case
    // (`reviewer_profile`, etc.), so this is just that convention for the
    // predicate's `pathGlob` field, reusing the rename mechanism already
    // applied to every parsed predicate.
    ["path_glob", "pathGlob"],
]);

/**
 * Accepts either the current predicate shape or the legacy claim shape and
 * returns the current shape, or `undefined` when the value cannot be migrated
 * without changing what it matches.
 */
export function migratePermissionPredicate(
    value: unknown,
): PermissionPredicate | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (UNMIGRATABLE_FIELDS.some((field) => value[field] !== undefined)) {
        return undefined;
    }
    if (
        value.capability !== undefined
        && !MIGRATABLE_VERBS.has(value.capability as string)
    ) {
        return undefined;
    }

    const migrated: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
        if (field === undefined) {
            continue;
        }
        const renamed = RENAMED_FIELDS.get(key) ?? key;
        if (migrated[renamed] !== undefined) {
            // e.g. both `scope` and `path_scope` present: ambiguous.
            return undefined;
        }
        migrated[renamed] = field;
    }
    return isPermissionPredicate(migrated) ? migrated : undefined;
}

/**
 * Accepts either the current grant shape or the legacy one and returns the
 * current shape, or `undefined` when the grant cannot be migrated.
 */
export function migratePermissionGrant(
    value: unknown,
): PermissionGrant | undefined {
    if (
        !isRecord(value)
        || typeof value.id !== "string"
        || value.id.length === 0
        || value.scope !== "session"
        || value.lifetime !== "session"
    ) {
        return undefined;
    }
    const kind = migrateGrantKind(value.kind);
    const when = migratePermissionPredicate(value.when);
    if (kind === undefined || when === undefined) {
        return undefined;
    }
    return {
        id: value.id,
        kind,
        when,
        scope: "session",
        lifetime: "session",
    };
}

function migrateGrantKind(value: unknown): PermissionGrantKind | undefined {
    if (value === "capability") {
        return "action";
    }
    return isPermissionGrantKind(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
