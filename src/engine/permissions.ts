import { homedir } from "node:os";
import { basename, dirname, parse, resolve, sep } from "node:path";

import type { HookToolCall } from "../sdk/hooks.ts";
import {
    isApprovalMode,
    parseApprovalMode,
    type ApprovalMode,
    type BuiltInPermissionProfileName,
} from "../sdk/permissions.ts";
import {
    nestedShellCommands,
    simpleCommandExecutableIndex,
    tokenizeSimpleCommands,
} from "../tools/bash-danger.ts";
import {
    applyPermissionGrant,
    permissionPredicateMatches,
    type PermissionGrant,
} from "./permission-grants.ts";

export { isApprovalMode, parseApprovalMode };
export type { ApprovalMode };
export {
    isPermissionGrant,
    isPermissionGrantProposal,
    isPermissionPredicate,
    permissionGrantProposals,
} from "./permission-grants.ts";
export type {
    PermissionGrant,
    PermissionGrantKind,
    PermissionGrantProposal,
} from "./permission-grants.ts";

export type PermissionOutcome = "allow" | "review" | "ask" | "deny";
export type PermissionCapability =
    | "read"
    | "write"
    | "delete"
    | "execute"
    | "network"
    | "unknown";
export type PermissionConfidence = "exact" | "partial" | "unknown";
export type PermissionPathScope = "workspace" | "outside_workspace";

export interface PermissionClaim {
    readonly tool: string;
    readonly capability: PermissionCapability;
    readonly confidence: PermissionConfidence;
    readonly operation?: string;
    readonly path?: string;
    readonly pathScope?: PermissionPathScope;
    readonly recursive?: boolean;
    readonly executable?: string;
}

export interface PermissionPredicate {
    readonly tool?: string;
    readonly capability?: PermissionCapability;
    readonly confidence?: PermissionConfidence;
    readonly operation?: string;
    readonly path?: string;
    readonly pathScope?: PermissionPathScope;
    readonly recursive?: boolean;
    readonly executable?: string;
}

export interface PermissionRule {
    readonly name: string;
    readonly when: PermissionPredicate;
    readonly then: PermissionOutcome;
}

export interface PermissionProfile {
    readonly name: string;
    readonly rules: readonly PermissionRule[];
    readonly defaultOutcome: PermissionOutcome;
    readonly reviewerProfile?: string;
}

export interface PermissionClaimDecision {
    readonly claim: PermissionClaim;
    readonly outcome: PermissionOutcome;
    readonly rule: string;
    readonly grant?: string;
}

export interface AllowToolPermission {
    readonly behavior: "allow";
    readonly claims: readonly PermissionClaimDecision[];
}

export interface ReviewToolPermission {
    readonly behavior: "review";
    readonly reason: string;
    readonly claims: readonly PermissionClaimDecision[];
    readonly reviewerProfile: string;
}

export interface AskToolPermission {
    readonly behavior: "ask";
    readonly reason: string;
    readonly claims: readonly PermissionClaimDecision[];
}

export interface DenyToolPermission {
    readonly behavior: "deny";
    readonly reason: string;
    readonly claims: readonly PermissionClaimDecision[];
    readonly source: "profile" | "accident_guard";
}

export type ToolPermissionDecision =
    | AllowToolPermission
    | ReviewToolPermission
    | AskToolPermission
    | DenyToolPermission;

export interface DecideToolPermissionOptions {
    readonly homeDirectory?: string;
    readonly permissionProfiles?: Readonly<Record<string, PermissionProfile>>;
}

const ROUTINE_RULES: readonly PermissionRule[] = [
    {
        name: "routine.user_interaction",
        when: { tool: "ask_user" },
        then: "allow",
    },
    {
        name: "routine.read",
        when: { capability: "read" },
        then: "allow",
    },
    {
        name: "routine.workspace_write",
        when: {
            capability: "write",
            confidence: "exact",
            pathScope: "workspace",
        },
        then: "allow",
    },
    {
        name: "routine.git_commit",
        when: { operation: "git.commit" },
        then: "allow",
    },
];

export const BUILT_IN_PERMISSION_PROFILES: Readonly<
    Record<BuiltInPermissionProfileName, PermissionProfile>
> = {
    full_access: {
        name: "full_access",
        rules: [],
        defaultOutcome: "allow",
    },
    ask: {
        name: "ask",
        rules: ROUTINE_RULES,
        defaultOutcome: "ask",
    },
    auto: {
        name: "auto",
        rules: ROUTINE_RULES,
        defaultOutcome: "review",
        reviewerProfile: "default",
    },
};

const OUTCOME_WEIGHT: Readonly<Record<PermissionOutcome, number>> = {
    allow: 0,
    review: 1,
    ask: 2,
    deny: 3,
};

const READ_COMMANDS = new Set([
    "cat",
    "grep",
    "head",
    "ls",
    "stat",
    "tail",
    "wc",
    "pwd",
]);

const NETWORK_COMMANDS = new Set([
    "curl",
    "ftp",
    "nc",
    "ncat",
    "scp",
    "sftp",
    "ssh",
    "telnet",
    "wget",
]);

const REDIRECT_ONLY_COMMANDS = new Set(["echo", "printf"]);

const NETWORK_GIT_OPERATIONS = new Map([
    ["clone", "git.clone"],
    ["fetch", "git.fetch"],
    ["ls-remote", "git.ls_remote"],
    ["pull", "git.pull"],
    ["push", "git.push"],
]);

export const CORE_PERMISSION_OPERATIONS = new Set([
    "git.clone",
    "git.commit",
    "git.fetch",
    "git.ls_remote",
    "git.pull",
    "git.push",
    "git.remote_update",
]);

const GIT_OPTIONS_WITH_VALUE = new Set([
    "-C",
    "-c",
    "--config-env",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
]);

const MAX_NESTED_SHELL_DEPTH = 4;

export function decideToolPermission(
    mode: ApprovalMode,
    toolCall: HookToolCall,
    workspace: string,
    grants: readonly PermissionGrant[] = [],
    options: DecideToolPermissionOptions = {},
): ToolPermissionDecision {
    const guardReason = accidentGuardReason(
        toolCall,
        workspace,
        options.homeDirectory ?? homedir(),
    );
    if (guardReason !== undefined) {
        return {
            behavior: "deny",
            reason: guardReason,
            claims: [],
            source: "accident_guard",
        };
    }

    const profile = builtInPermissionProfile(mode)
        ?? options.permissionProfiles?.[mode];
    if (profile === undefined) {
        return {
            behavior: "deny",
            reason: `Permission profile ${mode} is unavailable.`,
            claims: [],
            source: "profile",
        };
    }
    const decisions = extractPermissionClaims(toolCall, workspace).map(
        (claim) => evaluateClaim(profile, claim, grants),
    );
    const effective = decisions.reduce<PermissionOutcome>(
        (outcome, decision) =>
            OUTCOME_WEIGHT[decision.outcome] > OUTCOME_WEIGHT[outcome]
                ? decision.outcome
                : outcome,
        "allow",
    );

    if (effective === "allow") {
        return { behavior: "allow", claims: decisions };
    }

    const reason = permissionReason(profile, decisions, effective);
    if (effective === "review") {
        if (profile.reviewerProfile === undefined) {
            return {
                behavior: "deny",
                reason: `Permission profile ${profile.name} routes to review but has no reviewer profile.`,
                claims: decisions,
                source: "profile",
            };
        }
        return {
            behavior: "review",
            reason,
            claims: decisions,
            reviewerProfile: profile.reviewerProfile,
        };
    }
    if (effective === "ask") {
        return { behavior: "ask", reason, claims: decisions };
    }
    return {
        behavior: "deny",
        reason,
        claims: decisions,
        source: "profile",
    };
}

export function builtInPermissionProfile(
    name: string,
): PermissionProfile | undefined {
    return name === "ask" || name === "auto" || name === "full_access"
        ? BUILT_IN_PERMISSION_PROFILES[name]
        : undefined;
}

export function extractPermissionClaims(
    toolCall: HookToolCall,
    workspace: string,
): readonly PermissionClaim[] {
    if (toolCall.name === "read") {
        return [pathClaim(toolCall, "read", workspace)];
    }
    if (toolCall.name === "write" || toolCall.name === "edit") {
        return [pathClaim(toolCall, "write", workspace)];
    }
    if (toolCall.name !== "bash") {
        return [{
            tool: toolCall.name,
            capability: "unknown",
            confidence: "unknown",
        }];
    }

    const command = toolCall.input.command;
    if (typeof command !== "string") {
        return [{
            tool: "bash",
            capability: "unknown",
            confidence: "unknown",
        }];
    }
    return extractBashClaims(command, workspace);
}

export function evaluateClaim(
    profile: PermissionProfile,
    claim: PermissionClaim,
    grants: readonly PermissionGrant[] = [],
): PermissionClaimDecision {
    let profileDecision: PermissionClaimDecision;
    for (const rule of profile.rules) {
        if (permissionPredicateMatches(rule.when, claim)) {
            profileDecision = {
                claim,
                outcome: rule.then,
                rule: rule.name,
            };
            return applyPermissionGrant(profileDecision, grants);
        }
    }
    profileDecision = {
        claim,
        outcome: profile.defaultOutcome,
        rule: `${profile.name}.default`,
    };
    return applyPermissionGrant(profileDecision, grants);
}

function pathClaim(
    toolCall: HookToolCall,
    capability: "read" | "write",
    workspace: string,
): PermissionClaim {
    const requestedPath = toolCall.input.path;
    if (typeof requestedPath !== "string") {
        return {
            tool: toolCall.name,
            capability,
            confidence: "unknown",
        };
    }
    const path = resolve(workspace, requestedPath);
    return {
        tool: toolCall.name,
        capability,
        confidence: "exact",
        path,
        pathScope: pathScope(path, workspace),
    };
}

function extractBashClaims(
    command: string,
    workspace: string,
    depth = 0,
): readonly PermissionClaim[] {
    const commands = tokenizeSimpleCommands(command);
    const claims = commands.flatMap((words) =>
        claimsForSimpleCommand(words, workspace)
    );
    if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return claims;
    }
    return [
        ...claims,
        ...nestedShellCommands(command, commands).flatMap((nested) =>
            extractBashClaims(nested, workspace, depth + 1)
        ),
    ];
}

function claimsForSimpleCommand(
    words: readonly string[],
    workspace: string,
): readonly PermissionClaim[] {
    const executableIndex = simpleCommandExecutableIndex(words);
    const executable = basename(words[executableIndex] ?? "");
    if (executable.length === 0) {
        return [{
            tool: "bash",
            capability: "unknown",
            confidence: "unknown",
        }];
    }

    const redirectClaims = outputRedirectClaims(words, workspace);
    if (executable === "git") {
        return [...gitClaims(words, executableIndex), ...redirectClaims];
    }
    if (NETWORK_COMMANDS.has(executable)) {
        return [{
            tool: "bash",
            capability: "network",
            confidence: "exact",
            executable,
        }, ...redirectClaims];
    }
    if (executable === "rm") {
        return [
            ...rmClaims(words, executableIndex, workspace),
            ...redirectClaims,
        ];
    }
    if (READ_COMMANDS.has(executable)) {
        return [{
            tool: "bash",
            capability: "read",
            confidence: "partial",
            executable,
        }, ...redirectClaims];
    }
    if (REDIRECT_ONLY_COMMANDS.has(executable) && redirectClaims.length > 0) {
        return redirectClaims;
    }
    return [{
        tool: "bash",
        capability: "unknown",
        confidence: "unknown",
        executable,
    }, ...redirectClaims];
}

function outputRedirectClaims(
    words: readonly string[],
    workspace: string,
): readonly PermissionClaim[] {
    const claims: PermissionClaim[] = [];
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? "";
        const inline = word.match(/^\d*(?:>|>>)(.+)$/);
        const separate = /^\d*(?:>|>>)$/.test(word)
            ? words[index + 1]
            : undefined;
        const target = inline?.[1] ?? separate;
        if (target === undefined || target.length === 0) {
            continue;
        }
        const path = resolve(workspace, target);
        claims.push({
            tool: "bash",
            capability: "write",
            confidence: hasShellExpansion(target) ? "unknown" : "exact",
            path,
            pathScope: pathScope(path, workspace),
            executable: "shell_redirect",
        });
        if (separate !== undefined) {
            index += 1;
        }
    }
    return claims;
}

function gitClaims(
    words: readonly string[],
    executableIndex: number,
): readonly PermissionClaim[] {
    const subcommandIndex = gitSubcommandIndex(words, executableIndex + 1);
    const subcommand = words[subcommandIndex] ?? "";
    if (subcommand === "commit") {
        return [{
            tool: "bash",
            capability: "write",
            confidence: "exact",
            operation: "git.commit",
            executable: "git",
        }];
    }
    const networkOperation = NETWORK_GIT_OPERATIONS.get(subcommand);
    if (networkOperation !== undefined) {
        return [{
            tool: "bash",
            capability: "network",
            confidence: "exact",
            operation: networkOperation,
            executable: "git",
        }];
    }
    if (subcommand === "remote" && words[subcommandIndex + 1] === "update") {
        return [{
            tool: "bash",
            capability: "network",
            confidence: "exact",
            operation: "git.remote_update",
            executable: "git",
        }];
    }
    return [{
        tool: "bash",
        capability: "unknown",
        confidence: "partial",
        executable: "git",
    }];
}

function rmClaims(
    words: readonly string[],
    executableIndex: number,
    workspace: string,
): readonly PermissionClaim[] {
    const parsed = parseRm(words.slice(executableIndex + 1));
    if (parsed.targets.length === 0) {
        return [{
            tool: "bash",
            capability: "delete",
            confidence: "unknown",
            recursive: parsed.recursive,
            executable: "rm",
        }];
    }
    return parsed.targets.map((target) => {
        const path = resolve(workspace, target);
        return {
            tool: "bash",
            capability: "delete",
            confidence: hasShellExpansion(target) ? "unknown" : "exact",
            path,
            pathScope: pathScope(path, workspace),
            recursive: parsed.recursive,
            executable: "rm",
        };
    });
}

function permissionReason(
    profile: PermissionProfile,
    decisions: readonly PermissionClaimDecision[],
    effective: PermissionOutcome,
): string {
    const matches = decisions
        .filter((decision) => decision.outcome === effective)
        .map((decision) => `${describeClaim(decision.claim)} (${decision.rule})`);
    return `Permission profile ${profile.name} requires ${effective}: ${matches.join(", ")}.`;
}

function describeClaim(claim: PermissionClaim): string {
    if (claim.operation !== undefined) {
        return claim.operation;
    }
    if (claim.path !== undefined) {
        return `${claim.capability} ${claim.path}`;
    }
    return claim.executable === undefined
        ? `${claim.tool}:${claim.capability}`
        : `${claim.executable}:${claim.capability}`;
}

function pathScope(path: string, workspace: string): PermissionPathScope {
    const root = resolve(workspace);
    return path === root || path.startsWith(`${root}${sep}`)
        ? "workspace"
        : "outside_workspace";
}

function accidentGuardReason(
    toolCall: HookToolCall,
    workspace: string,
    homeDirectory: string,
): string | undefined {
    if (toolCall.name !== "bash") {
        return undefined;
    }
    const command = toolCall.input.command;
    if (typeof command !== "string") {
        return undefined;
    }
    return accidentGuardForBash(command, workspace, homeDirectory, workspace, 0);
}

function accidentGuardForBash(
    command: string,
    workspace: string,
    homeDirectory: string,
    initialDirectory: string,
    depth: number,
): string | undefined {
    const commands = tokenizeSimpleCommands(command);
    let workingDirectory = resolve(initialDirectory);
    for (const words of commands) {
        const executableIndex = simpleCommandExecutableIndex(words);
        const executable = basename(words[executableIndex] ?? "");
        if (executable === "cd") {
            const target = words[executableIndex + 1];
            if (target !== undefined && !hasShellExpansion(target)) {
                workingDirectory = resolveShellPath(
                    target,
                    workingDirectory,
                    homeDirectory,
                );
            }
            continue;
        }
        if (executable !== "rm") {
            continue;
        }
        const parsedRm = parseRm(words.slice(executableIndex + 1));
        if (!parsedRm.recursive) {
            continue;
        }
        for (const target of parsedRm.targets) {
            const reason = prohibitedDeletionReason(
                target,
                workingDirectory,
                workspace,
                homeDirectory,
            );
            if (reason !== undefined) {
                return reason;
            }
        }
    }

    if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return undefined;
    }
    for (const nested of nestedShellCommands(command, commands)) {
        const reason = accidentGuardForBash(
            nested,
            workspace,
            homeDirectory,
            workingDirectory,
            depth + 1,
        );
        if (reason !== undefined) {
            return reason;
        }
    }
    return undefined;
}

function prohibitedDeletionReason(
    target: string,
    workingDirectory: string,
    workspace: string,
    homeDirectory: string,
): string | undefined {
    if (hasUnresolvedExpansion(target)) {
        return undefined;
    }
    const broadGlob = isBroadImmediateGlob(target);
    const resolvedTarget = resolveShellPath(
        broadGlob ? dirname(target) : target,
        workingDirectory,
        homeDirectory,
    );
    const root = parse(resolvedTarget).root;
    const protectedReason =
        isFilesystemOrVolumeRoot(resolvedTarget, root)
            ? "a filesystem or volume root"
            : resolvedTarget === resolve(homeDirectory)
                ? broadGlob
                    ? "the contents of the home directory"
                    : "the home directory"
                : isWorkspaceOrAncestor(resolvedTarget, workspace)
                    ? broadGlob
                        ? "the contents of the workspace or one of its ancestors"
                        : resolvedTarget === resolve(workspace)
                            ? "the workspace root"
                            : "an ancestor of the workspace"
                    : undefined;
    return protectedReason === undefined
        ? undefined
        : `Accident guard refused recursive deletion of ${protectedReason}. Run this operation manually if it is intentional.`;
}

function parseRm(words: readonly string[]): {
    readonly recursive: boolean;
    readonly targets: readonly string[];
} {
    let recursive = false;
    let optionsEnded = false;
    const targets: string[] = [];
    for (const word of words) {
        if (!optionsEnded && word === "--") {
            optionsEnded = true;
            continue;
        }
        if (!optionsEnded && word.startsWith("-")) {
            recursive = recursive
                || word === "--recursive"
                || (!word.startsWith("--")
                    && (word.includes("r") || word.includes("R")));
            continue;
        }
        targets.push(word);
    }
    return { recursive, targets };
}

function resolveShellPath(
    target: string,
    workingDirectory: string,
    homeDirectory: string,
): string {
    if (target === "~") {
        return resolve(homeDirectory);
    }
    if (target.startsWith("~/")) {
        return resolve(homeDirectory, target.slice(2));
    }
    return resolve(workingDirectory, target);
}

function isWorkspaceOrAncestor(candidate: string, workspace: string): boolean {
    const root = resolve(workspace);
    return candidate === root || root.startsWith(`${candidate}${sep}`);
}

function isBroadImmediateGlob(target: string): boolean {
    const name = basename(target);
    return name === "*"
        || name === ".*"
        || name === "?"
        || name === "{*,.*}";
}

function isFilesystemOrVolumeRoot(path: string, filesystemRoot: string): boolean {
    if (path === filesystemRoot) {
        return true;
    }
    if (process.platform !== "darwin") {
        return false;
    }
    const parts = path.split(sep).filter((part) => part.length > 0);
    return parts.length === 2 && parts[0] === "Volumes";
}

function hasUnresolvedExpansion(target: string): boolean {
    return target.includes("$(")
        || target.includes("`")
        || target.includes("$")
        || target.includes("${");
}

function hasShellExpansion(target: string): boolean {
    return hasUnresolvedExpansion(target)
        || target.includes("*")
        || target.includes("?")
        || target.includes("[")
        || target.includes("{");
}

function gitSubcommandIndex(words: readonly string[], start: number): number {
    let index = start;
    while (index < words.length) {
        const word = words[index] ?? "";
        if (GIT_OPTIONS_WITH_VALUE.has(word)) {
            index += 2;
        } else if (word.startsWith("-")) {
            index += 1;
        } else {
            break;
        }
    }
    return index;
}
