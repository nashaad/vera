import { basename, sep } from "node:path";

import type {
    PermissionAction,
    PermissionActionDecision,
    PermissionPredicate,
    ToolPermissionDecision,
} from "./permissions.ts";

export type PermissionGrantKind = "action" | "command";

export interface PermissionGrant {
    readonly id: string;
    readonly kind: PermissionGrantKind;
    readonly when: PermissionPredicate;
    readonly scope: "session";
    readonly lifetime: "session";
}

export interface PermissionGrantProposal {
    readonly kind: PermissionGrantKind;
    readonly when: PermissionPredicate;
    readonly scope: "session";
    readonly lifetime: "session";
}

const PREDICATE_FIELDS = [
    "tool",
    "verb",
    "path",
    "pathGlob",
    "scope",
    "operation",
    "executable",
] as const;

const VERBS = ["read", "write", "delete", "unknown"];

/**
 * Grants only ever lower `review` or `ask` to `allow`. They can never override
 * a profile denial, and they are consulted after the accident guard.
 */
export function applyPermissionGrant(
    decision: PermissionActionDecision,
    grants: readonly PermissionGrant[],
): PermissionActionDecision {
    if (decision.outcome !== "ask" && decision.outcome !== "review") {
        return decision;
    }
    const grant = grants.find((candidate) =>
        permissionPredicateMatches(candidate.when, decision.action)
    );
    return grant === undefined
        ? decision
        : { ...decision, outcome: "allow", grant: grant.id };
}

export function permissionGrantProposals(
    decision: ToolPermissionDecision,
): readonly PermissionGrantProposal[] {
    if (decision.behavior !== "ask" && decision.behavior !== "review") {
        return [];
    }
    const proposals: PermissionGrantProposal[] = [];
    for (const actionDecision of decision.actions) {
        if (
            actionDecision.outcome !== "ask"
            && actionDecision.outcome !== "review"
        ) {
            continue;
        }
        const proposal = grantProposalForAction(actionDecision.action);
        if (
            !proposals.some((existing) => sameGrantProposal(existing, proposal))
        ) {
            proposals.push(proposal);
        }
    }
    return proposals;
}

export function isPermissionGrantProposal(
    value: unknown,
): value is PermissionGrantProposal {
    if (!isRecord(value)) {
        return false;
    }
    return hasExactKeys(value, ["kind", "when", "scope", "lifetime"])
        && isPermissionGrantKind(value.kind)
        && value.scope === "session"
        && value.lifetime === "session"
        && isPermissionPredicate(value.when);
}

export function isPermissionGrant(value: unknown): value is PermissionGrant {
    return isRecord(value)
        && hasExactKeys(value, ["id", "kind", "when", "scope", "lifetime"])
        && typeof value.id === "string"
        && value.id.length > 0
        && isPermissionGrantKind(value.kind)
        && value.scope === "session"
        && value.lifetime === "session"
        && isPermissionPredicate(value.when);
}

export function isPermissionGrantKind(
    value: unknown,
): value is PermissionGrantKind {
    return value === "action" || value === "command";
}

export function isPermissionPredicate(
    value: unknown,
): value is PermissionPredicate {
    if (!isRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return keys.length > 0
        && keys.every((key) =>
            (PREDICATE_FIELDS as readonly string[]).includes(key)
        )
        && (value.tool === undefined || isNonEmptyString(value.tool))
        && (value.verb === undefined || VERBS.includes(value.verb as string))
        && (value.operation === undefined
            || isNonEmptyString(value.operation))
        && (value.path === undefined || isNonEmptyString(value.path))
        && (value.pathGlob === undefined || isNonEmptyString(value.pathGlob))
        && (value.scope === undefined
            || value.scope === "workspace"
            || value.scope === "outside_workspace")
        && (value.executable === undefined
            || isNonEmptyString(value.executable));
}

/** Every field present on the predicate must match; absent fields are ignored. */
export function permissionPredicateMatches(
    predicate: PermissionPredicate,
    action: PermissionAction,
): boolean {
    return (predicate.tool === undefined || predicate.tool === action.tool)
        && (predicate.verb === undefined || predicate.verb === action.verb)
        && (predicate.operation === undefined
            || operationMatches(predicate.operation, action.operation))
        && (predicate.path === undefined
            || action.path === predicate.path
            || action.path?.startsWith(`${predicate.path}${sep}`) === true)
        && (predicate.pathGlob === undefined
            || pathBasenameMatchesGlob(predicate.pathGlob, action.path))
        && (predicate.scope === undefined || predicate.scope === action.scope)
        && (predicate.executable === undefined
            || predicate.executable === action.executable);
}

/**
 * Matches a glob (only `*` is special, meaning "zero or more characters")
 * against an action's basename, e.g. `.env.*` matches `/repo/.env.local`.
 * Case-sensitive, and never matches when the action has no resolved path.
 */
function pathBasenameMatchesGlob(glob: string, path: string | undefined): boolean {
    if (path === undefined) {
        return false;
    }
    const pattern = glob.split("*").map(escapeRegExpLiteral).join(".*");
    return new RegExp(`^${pattern}$`).test(basename(path));
}

function escapeRegExpLiteral(segment: string): string {
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function grantProposalForAction(
    action: PermissionAction,
): PermissionGrantProposal {
    const base = {
        scope: "session" as const,
        lifetime: "session" as const,
    };
    if (action.operation !== undefined) {
        return { ...base, kind: "action", when: { operation: action.operation } };
    }
    if (action.path !== undefined) {
        return {
            ...base,
            kind: "action",
            when: { verb: action.verb, path: action.path },
        };
    }
    if (
        action.tool === "bash"
        && action.executable !== undefined
        && action.verb === "unknown"
    ) {
        return {
            ...base,
            kind: "command",
            when: { tool: "bash", executable: action.executable },
        };
    }
    return {
        ...base,
        kind: "action",
        when: {
            verb: action.verb,
            ...(action.scope === undefined ? {} : { scope: action.scope }),
            ...(action.executable === undefined
                ? {}
                : { executable: action.executable }),
        },
    };
}

function operationMatches(
    pattern: string,
    operation: string | undefined,
): boolean {
    if (operation === undefined) {
        return false;
    }
    return pattern.endsWith("*")
        ? operation.startsWith(pattern.slice(0, -1))
        : pattern === operation;
}

function sameGrantProposal(
    left: PermissionGrantProposal,
    right: PermissionGrantProposal,
): boolean {
    return left.kind === right.kind
        && JSON.stringify(left.when) === JSON.stringify(right.when);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length
        && expected.every((key) => Object.hasOwn(value, key));
}
