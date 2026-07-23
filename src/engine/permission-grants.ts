import { sep } from "node:path";

import type {
    PermissionClaim,
    PermissionClaimDecision,
    PermissionPredicate,
    ToolPermissionDecision,
} from "./permissions.ts";

export type PermissionGrantKind = "capability" | "command";

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

export function applyPermissionGrant(
    decision: PermissionClaimDecision,
    grants: readonly PermissionGrant[],
): PermissionClaimDecision {
    if (decision.outcome !== "ask" && decision.outcome !== "review") {
        return decision;
    }
    const grant = grants.find((candidate) =>
        permissionPredicateMatches(candidate.when, decision.claim)
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
    for (const claimDecision of decision.claims) {
        if (
            claimDecision.outcome !== "ask"
            && claimDecision.outcome !== "review"
        ) {
            continue;
        }
        const proposal = grantProposalForClaim(claimDecision.claim);
        if (
            proposal !== undefined
            && !proposals.some((existing) =>
                sameGrantProposal(existing, proposal)
            )
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
        && (value.kind === "capability" || value.kind === "command")
        && value.scope === "session"
        && value.lifetime === "session"
        && isPermissionPredicate(value.when);
}

export function isPermissionGrant(value: unknown): value is PermissionGrant {
    return isRecord(value)
        && hasExactKeys(value, ["id", "kind", "when", "scope", "lifetime"])
        && typeof value.id === "string"
        && value.id.length > 0
        && (value.kind === "capability" || value.kind === "command")
        && value.scope === "session"
        && value.lifetime === "session"
        && isPermissionPredicate(value.when);
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
            [
                "tool",
                "capability",
                "confidence",
                "operation",
                "path",
                "pathScope",
                "recursive",
                "executable",
            ].includes(key)
        )
        && (value.tool === undefined || isNonEmptyString(value.tool))
        && (value.capability === undefined
            || [
                "read",
                "write",
                "delete",
                "execute",
                "network",
                "unknown",
            ].includes(value.capability as string))
        && (value.confidence === undefined
            || ["exact", "partial", "unknown"].includes(
                value.confidence as string,
            ))
        && (value.operation === undefined
            || isNonEmptyString(value.operation))
        && (value.path === undefined || isNonEmptyString(value.path))
        && (value.pathScope === undefined
            || value.pathScope === "workspace"
            || value.pathScope === "outside_workspace")
        && (value.recursive === undefined
            || typeof value.recursive === "boolean")
        && (value.executable === undefined
            || isNonEmptyString(value.executable));
}

export function permissionPredicateMatches(
    predicate: PermissionPredicate,
    claim: PermissionClaim,
): boolean {
    return (predicate.tool === undefined || predicate.tool === claim.tool)
        && (predicate.capability === undefined
            || predicate.capability === claim.capability)
        && (predicate.confidence === undefined
            || predicate.confidence === claim.confidence)
        && (predicate.operation === undefined
            || operationMatches(predicate.operation, claim.operation))
        && (predicate.path === undefined
            || claim.path === predicate.path
            || claim.path?.startsWith(`${predicate.path}${sep}`) === true)
        && (predicate.pathScope === undefined
            || predicate.pathScope === claim.pathScope)
        && (predicate.recursive === undefined
            || predicate.recursive === claim.recursive)
        && (predicate.executable === undefined
            || predicate.executable === claim.executable);
}

function grantProposalForClaim(
    claim: PermissionClaim,
): PermissionGrantProposal | undefined {
    const base = {
        scope: "session" as const,
        lifetime: "session" as const,
    };
    if (claim.operation !== undefined) {
        return {
            ...base,
            kind: "capability",
            when: { operation: claim.operation },
        };
    }
    if (claim.path !== undefined && claim.confidence === "exact") {
        return {
            ...base,
            kind: "capability",
            when: {
                capability: claim.capability,
                path: claim.path,
                ...(claim.recursive === undefined
                    ? {}
                    : { recursive: claim.recursive }),
            },
        };
    }
    if (
        claim.tool === "bash"
        && claim.executable !== undefined
        && claim.capability === "unknown"
    ) {
        return {
            ...base,
            kind: "command",
            when: { tool: "bash", executable: claim.executable },
        };
    }
    return {
        ...base,
        kind: "capability",
        when: {
            capability: claim.capability,
            ...(claim.pathScope === undefined
                ? {}
                : { pathScope: claim.pathScope }),
            ...(claim.executable === undefined
                ? {}
                : { executable: claim.executable }),
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
