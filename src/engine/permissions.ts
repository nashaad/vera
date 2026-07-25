import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "node:path";

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
import { toolPermissionInputs } from "../tools/execute.ts";
import type { PermissionInputSpec } from "../tools/types.ts";
import {
    applyPermissionGrant,
    isPermissionGrant,
    isPermissionPredicate,
    permissionPredicateMatches,
    type PermissionGrant,
} from "./permission-grants.ts";
import {
    applyPermissionPreference,
    isPermissionPreference,
    type PermissionPreference,
} from "./permission-preferences.ts";

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
export {
    addPermissionPreference,
    defaultPermissionPreferencesPath,
    isPermissionPreference,
    listPermissionPreferences,
    loadPermissionPreferences,
    removePermissionPreference,
} from "./permission-preferences.ts";
export type { PermissionPreference } from "./permission-preferences.ts";

export type PermissionOutcome = "allow" | "review" | "ask" | "deny";
export type PermissionVerb = "read" | "write" | "delete" | "unknown";
export type PermissionScope = "workspace" | "outside_workspace";

/**
 * One recognized effect of a tool call. A call that Vera cannot describe
 * safely produces an `unknown` action rather than a concrete one, so it can
 * never match an allow rule by accident.
 */
export interface PermissionAction {
    readonly tool: string;
    readonly verb: PermissionVerb;
    /** Resolved absolute path. Absent when no path could be resolved. */
    readonly path?: string;
    /** Set only alongside `path`. */
    readonly scope?: PermissionScope;
    /**
     * Label for a deliberately recognized operation such as `git.commit`.
     * Not a claim that every runtime side effect has been discovered.
     */
    readonly operation?: string;
    /** Literal command name for Bash actions, e.g. `git`, `rm`. */
    readonly executable?: string;
}

/** A complete tool call, which may produce zero or more actions. */
export interface PermissionRequest {
    readonly toolCall: HookToolCall;
    readonly workspace: string;
    readonly homeDirectory: string;
}

export interface PermissionPredicate {
    readonly tool?: string;
    readonly verb?: PermissionVerb;
    readonly path?: string;
    readonly scope?: PermissionScope;
    readonly operation?: string;
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

export interface PermissionInspection {
    readonly selected: PermissionProfile;
    readonly availableProfiles: readonly string[];
    readonly activeGrants: readonly PermissionGrant[];
    /** Durable preferences layered on top of the selected profile. Optional
     * so existing call sites that predate preferences keep compiling. */
    readonly activePreferences?: readonly PermissionPreference[];
}

export interface PermissionActionDecision {
    readonly action: PermissionAction;
    readonly outcome: PermissionOutcome;
    readonly rule: string;
    readonly grant?: string;
    readonly preference?: string;
}

export interface AllowToolPermission {
    readonly behavior: "allow";
    readonly actions: readonly PermissionActionDecision[];
}

export interface ReviewToolPermission {
    readonly behavior: "review";
    readonly reason: string;
    readonly actions: readonly PermissionActionDecision[];
    readonly reviewerProfile: string;
}

export interface AskToolPermission {
    readonly behavior: "ask";
    readonly reason: string;
    readonly actions: readonly PermissionActionDecision[];
}

export interface DenyToolPermission {
    readonly behavior: "deny";
    readonly reason: string;
    readonly actions: readonly PermissionActionDecision[];
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
    readonly permissionPreferences?: readonly PermissionPreference[];
}

const ROUTINE_RULES: readonly PermissionRule[] = [
    {
        name: "routine.user_interaction",
        when: { tool: "ask_user" },
        then: "allow",
    },
    {
        name: "routine.read",
        when: { verb: "read" },
        then: "allow",
    },
    {
        // `scope` is only ever set alongside a resolved absolute path, so this
        // rule cannot match a write whose destination is unresolved.
        name: "routine.workspace_write",
        when: { verb: "write", scope: "workspace" },
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

/** Classifies a command's arguments (everything after the executable) as
 * provably read-only, or not. */
type ReadOnlyClassifier = (args: readonly string[]) => boolean;

function alwaysReadOnly(): boolean {
    return true;
}

/**
 * Read-only except for a small set of flags that turn the command into a
 * mutation, e.g. `find -exec`, `fd -x`, `sed -i`. Combined short flags
 * (`sed -ni`) are checked character-by-character; long flags match either
 * bare or in `--flag=value` form.
 */
function excludingDangerousFlags(flags: readonly string[]): ReadOnlyClassifier {
    return (args) => !args.some((word) => flags.some((flag) => matchesFlag(word, flag)));
}

function matchesFlag(word: string, flag: string): boolean {
    if (word === flag) {
        return true;
    }
    // A long flag can carry its value inline: `sed --in-place=.bak` is the
    // same mutation as `sed --in-place`, so compare only the name part.
    if (word.startsWith("--")) {
        const separator = word.indexOf("=");
        return separator > 0 && word.slice(0, separator) === flag;
    }
    if (flag.startsWith("--") || !word.startsWith("-") || word.length <= 1) {
        return false;
    }
    // Short flags can be bundled (`-ni`) or carry an inline value (`-i.bak`),
    // so a substring check over the cluster catches both.
    return word.slice(1).includes(flag.slice(1));
}

/** Read-only only for a fixed set of query subcommands, e.g. `npm view`. */
function matchingSubcommand(subcommands: readonly string[]): ReadOnlyClassifier {
    return (args) => subcommands.includes(args[0] ?? "");
}

/**
 * A small, deliberately incomplete map of commands Vera can prove are
 * read-only from their name and arguments alone, replacing a name-only
 * allowlist that could not express "safe except for this one flag." Anything
 * not listed here falls through to the normal rules and, in `auto`, the
 * reviewer — that is the safe default, not a gap to close by growing this
 * list without bound.
 */
const READ_ONLY_COMMANDS: Readonly<Record<string, ReadOnlyClassifier>> = {
    cat: alwaysReadOnly,
    head: alwaysReadOnly,
    tail: alwaysReadOnly,
    wc: alwaysReadOnly,
    pwd: alwaysReadOnly,
    stat: alwaysReadOnly,
    ls: alwaysReadOnly,
    grep: alwaysReadOnly,
    find: excludingDangerousFlags([
        "-exec",
        "-execdir",
        "-delete",
        "-ok",
        "-okdir",
        "-fprint",
        "-fprintf",
    ]),
    fd: excludingDangerousFlags(["-x", "--exec", "-X", "--exec-batch"]),
    sed: excludingDangerousFlags(["-i", "--in-place"]),
    npm: matchingSubcommand(["list", "ls", "view", "outdated", "why"]),
    pnpm: matchingSubcommand(["list", "ls", "why", "outdated"]),
    pip: matchingSubcommand(["list", "show", "freeze"]),
    cargo: matchingSubcommand(["tree", "search"]),
};

const REDIRECT_ONLY_COMMANDS = new Set(["echo", "printf"]);

const NETWORK_GIT_OPERATIONS = new Map([
    ["clone", "git.clone"],
    ["fetch", "git.fetch"],
    ["ls-remote", "git.ls_remote"],
    ["pull", "git.pull"],
    ["push", "git.push"],
]);

/**
 * Git subcommands that never mutate repository state, regardless of flags.
 * `branch` is handled separately since only `git branch --list` (not bare
 * `git branch`, which can also create) is provably read-only.
 */
const GIT_READ_SUBCOMMANDS = new Set(["log", "status", "diff", "show"]);

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
    const homeDirectory = options.homeDirectory ?? homedir();
    const guardReason = accidentGuardReason(toolCall, workspace, homeDirectory);
    if (guardReason !== undefined) {
        return {
            behavior: "deny",
            reason: guardReason,
            actions: [],
            source: "accident_guard",
        };
    }

    const profile = builtInPermissionProfile(mode)
        ?? options.permissionProfiles?.[mode];
    if (profile === undefined) {
        return {
            behavior: "deny",
            reason: `Permission profile ${mode} is unavailable.`,
            actions: [],
            source: "profile",
        };
    }
    const decisions = extractPermissionActions({
        toolCall,
        workspace,
        homeDirectory,
    }).map((action) =>
        evaluateAction(
            profile,
            action,
            grants,
            options.permissionPreferences ?? [],
        )
    );
    // Every action is evaluated; the strictest outcome wins. A recognized read
    // followed by an unresolved command still falls back to the profile.
    const effective = decisions.reduce<PermissionOutcome>(
        (outcome, decision) =>
            OUTCOME_WEIGHT[decision.outcome] > OUTCOME_WEIGHT[outcome]
                ? decision.outcome
                : outcome,
        "allow",
    );

    if (effective === "allow") {
        return { behavior: "allow", actions: decisions };
    }

    const reason = permissionReason(profile, decisions, effective);
    if (effective === "review") {
        if (profile.reviewerProfile === undefined) {
            return {
                behavior: "deny",
                reason: `Permission profile ${profile.name} routes to review but has no reviewer profile.`,
                actions: decisions,
                source: "profile",
            };
        }
        return {
            behavior: "review",
            reason,
            actions: decisions,
            reviewerProfile: profile.reviewerProfile,
        };
    }
    if (effective === "ask") {
        return { behavior: "ask", reason, actions: decisions };
    }
    return {
        behavior: "deny",
        reason,
        actions: decisions,
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

export function inspectPermissions(
    name: ApprovalMode,
    customProfiles: Readonly<Record<string, PermissionProfile>> = {},
    grants: readonly PermissionGrant[] = [],
    preferences: readonly PermissionPreference[] = [],
): PermissionInspection | undefined {
    const selected = builtInPermissionProfile(name) ?? customProfiles[name];
    if (selected === undefined) {
        return undefined;
    }
    return {
        selected: {
            name: selected.name,
            rules: selected.rules.map((rule) => ({
                name: rule.name,
                when: { ...rule.when },
                then: rule.then,
            })),
            defaultOutcome: selected.defaultOutcome,
            ...(selected.reviewerProfile === undefined
                ? {}
                : { reviewerProfile: selected.reviewerProfile }),
        },
        availableProfiles: [
            ...Object.keys(BUILT_IN_PERMISSION_PROFILES),
            ...Object.keys(customProfiles),
        ],
        activeGrants: grants.map((grant) => ({
            id: grant.id,
            kind: grant.kind,
            when: { ...grant.when },
            scope: grant.scope,
            lifetime: grant.lifetime,
        })),
        activePreferences: preferences.map((preference) => ({
            id: preference.id,
            when: { ...preference.when },
            createdAt: preference.createdAt,
        })),
    };
}

export function isPermissionInspection(
    value: unknown,
): value is PermissionInspection {
    if (!isRecord(value)) {
        return false;
    }
    const selected = isRecord(value.selected) ? value.selected : undefined;
    return selected !== undefined
        && typeof selected.name === "string"
        && selected.name.length > 0
        && Array.isArray(selected.rules)
        && selected.rules.every((rule) => {
            if (!isRecord(rule)) {
                return false;
            }
            return typeof rule.name === "string"
                && isPermissionPredicate(rule.when)
                && isPermissionOutcome(rule.then);
        })
        && isPermissionOutcome(selected.defaultOutcome)
        && (selected.reviewerProfile === undefined
            || (typeof selected.reviewerProfile === "string"
                && selected.reviewerProfile.length > 0))
        && Array.isArray(value.availableProfiles)
        && value.availableProfiles.every((name) =>
            typeof name === "string" && name.length > 0
        )
        && Array.isArray(value.activeGrants)
        && value.activeGrants.every(isPermissionGrant)
        && (value.activePreferences === undefined
            || (Array.isArray(value.activePreferences)
                && value.activePreferences.every(isPermissionPreference)));
}

export function extractPermissionActions(
    request: PermissionRequest,
): readonly PermissionAction[] {
    const { toolCall, workspace } = request;
    if (toolCall.name === "bash") {
        const command = toolCall.input.command;
        if (typeof command !== "string") {
            return [{ tool: "bash", verb: "unknown" }];
        }
        return extractBashActions(
            command,
            workspace,
            request.homeDirectory,
            resolve(workspace),
            0,
        );
    }

    // Any tool that declared path/URL inputs is gated the same way, whether
    // it is a built-in file tool or a future one. A tool that declared none
    // produces a single `unknown` action, same as an unrecognized bash
    // command.
    const declaredInputs = toolPermissionInputs(toolCall.name);
    if (declaredInputs === undefined || declaredInputs.length === 0) {
        return [{ tool: toolCall.name, verb: "unknown" }];
    }
    return declaredInputs.map((spec) =>
        structuredInputAction(toolCall, spec, workspace)
    );
}

export function evaluateAction(
    profile: PermissionProfile,
    action: PermissionAction,
    grants: readonly PermissionGrant[] = [],
    preferences: readonly PermissionPreference[] = [],
): PermissionActionDecision {
    for (const rule of profile.rules) {
        if (permissionPredicateMatches(rule.when, action)) {
            return applyPermissionSafetyNets({
                action,
                outcome: rule.then,
                rule: rule.name,
            }, preferences, grants);
        }
    }
    return applyPermissionSafetyNets({
        action,
        outcome: profile.defaultOutcome,
        rule: `${profile.name}.default`,
    }, preferences, grants);
}

/**
 * Preferences are checked first (a durable, user-curated first pass), then
 * session grants. Both share the same rail: a decision that already landed
 * on `allow` (or `deny`) is untouched, so neither layer can widen a denial.
 */
function applyPermissionSafetyNets(
    decision: PermissionActionDecision,
    preferences: readonly PermissionPreference[],
    grants: readonly PermissionGrant[],
): PermissionActionDecision {
    const afterPreference = applyPermissionPreference(decision, preferences);
    return afterPreference.outcome === "allow"
        ? afterPreference
        : applyPermissionGrant(afterPreference, grants);
}

/**
 * Turns a declared path/URL input into a concrete action. A field that is
 * missing or the wrong type becomes `unknown` rather than being silently
 * skipped, so it still falls through to the profile's default outcome
 * instead of passing permission checks unnoticed.
 */
function structuredInputAction(
    toolCall: HookToolCall,
    spec: PermissionInputSpec,
    workspace: string,
): PermissionAction {
    const raw = toolCall.input[spec.field];
    if (typeof raw !== "string" || raw.length === 0) {
        return { tool: toolCall.name, verb: "unknown" };
    }
    if (spec.kind === "url") {
        return {
            tool: toolCall.name,
            verb: spec.verb,
            path: raw,
            scope: "outside_workspace",
        };
    }
    // Structured tool inputs are literal paths, not shell words.
    const path = resolve(workspace, raw);
    return {
        tool: toolCall.name,
        verb: spec.verb,
        path,
        scope: pathScope(path, workspace),
    };
}

function extractBashActions(
    command: string,
    workspace: string,
    homeDirectory: string,
    initialDirectory: string | undefined,
    depth: number,
): readonly PermissionAction[] {
    const commands = reconnectFdDuplicationTargets(
        tokenizeSimpleCommands(command),
    );
    const actions: PermissionAction[] = [];
    let workingDirectory = initialDirectory;

    for (const words of commands) {
        actions.push(
            ...actionsForSimpleCommand(
                words,
                workspace,
                workingDirectory,
                homeDirectory,
            ),
        );
        workingDirectory = nextWorkingDirectory(
            words,
            workingDirectory,
            homeDirectory,
        );
    }

    if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return actions;
    }
    return [
        ...actions,
        ...nestedShellCommands(command, commands).flatMap((nested) =>
            extractBashActions(
                nested,
                workspace,
                homeDirectory,
                workingDirectory,
                depth + 1,
            )
        ),
    ];
}

/**
 * Tracks `cd` so later relative paths are resolved against the right
 * directory. A `cd` we cannot resolve makes the directory unknown, which turns
 * every later relative path into an `unknown` action instead of a guess.
 */
function nextWorkingDirectory(
    words: readonly string[],
    workingDirectory: string | undefined,
    homeDirectory: string,
): string | undefined {
    const executableIndex = simpleCommandExecutableIndex(words);
    if (basename(words[executableIndex] ?? "") !== "cd") {
        return workingDirectory;
    }
    const target = words[executableIndex + 1];
    return target === undefined
        ? resolve(homeDirectory)
        : resolveShellTarget(target, workingDirectory, homeDirectory);
}

function actionsForSimpleCommand(
    words: readonly string[],
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): readonly PermissionAction[] {
    const executableIndex = simpleCommandExecutableIndex(words);
    const executable = basename(words[executableIndex] ?? "");
    if (executable.length === 0) {
        return [{ tool: "bash", verb: "unknown" }];
    }

    const redirects = outputRedirectActions(
        words,
        workspace,
        workingDirectory,
        homeDirectory,
    );
    if (executable === "git") {
        return [...gitActions(words, executableIndex), ...redirects];
    }
    if (executable === "rm") {
        return [
            ...rmActions(
                words,
                executableIndex,
                workspace,
                workingDirectory,
                homeDirectory,
            ),
            ...redirects,
        ];
    }
    const readOnlyClassifier = READ_ONLY_COMMANDS[executable];
    if (
        readOnlyClassifier !== undefined
        && readOnlyClassifier(words.slice(executableIndex + 1))
    ) {
        return [{ tool: "bash", verb: "read", executable }, ...redirects];
    }
    if (REDIRECT_ONLY_COMMANDS.has(executable) && redirects.length > 0) {
        return redirects;
    }
    return [{ tool: "bash", verb: "unknown", executable }, ...redirects];
}

const INERT_REDIRECT_TARGETS = new Set([
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/stdin",
]);

/**
 * `/dev/null` and friends have no observable effect, and `2>&1` duplicates a
 * file descriptor rather than naming a path. Neither should escalate a
 * command past a plain read.
 */
function isInertRedirectTarget(target: string): boolean {
    if (target.startsWith("&")) {
        return true;
    }
    return INERT_REDIRECT_TARGETS.has(target);
}

/**
 * The tokenizer splits on a bare `&` because it doubles as the background
 * operator, so `2>&1` comes back as two "commands": `[..., "2>"]` and
 * `["1"]`. Reconnect that split before redirect analysis runs, so fd
 * duplication is recognized instead of misread as an unrelated command.
 */
function reconnectFdDuplicationTargets(
    commands: readonly string[][],
): string[][] {
    const result: string[][] = [];
    let index = 0;
    while (index < commands.length) {
        const words = commands[index] ?? [];
        const last = words.at(-1) ?? "";
        const next = commands[index + 1];
        const fdTarget = next?.[0];
        if (
            next !== undefined
            && /^\d*>$/.test(last)
            && fdTarget !== undefined
            && /^\d+$/.test(fdTarget)
        ) {
            result.push([...words.slice(0, -1), `${last}&${fdTarget}`]);
            const remainder = next.slice(1);
            if (remainder.length > 0) {
                result.push(remainder);
            }
            index += 2;
            continue;
        }
        result.push(words);
        index += 1;
    }
    return result;
}

function outputRedirectActions(
    words: readonly string[],
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): readonly PermissionAction[] {
    const actions: PermissionAction[] = [];
    for (let index = 0; index < words.length; index += 1) {
        // `>>` must be tried before `>`, or `>>` parses as `>` with the second
        // `>` captured as the target.
        const redirect = (words[index] ?? "").match(/^\d*(?:>>|>)(.*)$/);
        if (redirect === null) {
            continue;
        }
        const attached = redirect[1] ?? "";
        const target = attached.length > 0 ? attached : words[index + 1];
        if (attached.length === 0) {
            index += 1;
        }
        if (target === undefined || target.length === 0) {
            continue;
        }
        if (isInertRedirectTarget(target)) {
            actions.push({ tool: "bash", verb: "read", executable: "shell_redirect" });
            continue;
        }
        actions.push(shellPathAction(
            "write",
            target,
            "shell_redirect",
            workspace,
            workingDirectory,
            homeDirectory,
        ));
    }
    return actions;
}

function gitActions(
    words: readonly string[],
    executableIndex: number,
): readonly PermissionAction[] {
    const subcommandIndex = gitSubcommandIndex(words, executableIndex + 1);
    const subcommand = words[subcommandIndex] ?? "";
    if (subcommand === "commit") {
        return [{
            tool: "bash",
            verb: "write",
            operation: "git.commit",
            executable: "git",
        }];
    }
    const networkOperation = NETWORK_GIT_OPERATIONS.get(subcommand);
    if (networkOperation !== undefined) {
        return [{
            tool: "bash",
            verb: "unknown",
            operation: networkOperation,
            executable: "git",
        }];
    }
    if (subcommand === "remote" && words[subcommandIndex + 1] === "update") {
        return [{
            tool: "bash",
            verb: "unknown",
            operation: "git.remote_update",
            executable: "git",
        }];
    }
    if (
        GIT_READ_SUBCOMMANDS.has(subcommand)
        || (subcommand === "branch" && words[subcommandIndex + 1] === "--list")
    ) {
        return [{ tool: "bash", verb: "read", executable: "git" }];
    }
    return [{ tool: "bash", verb: "unknown", executable: "git" }];
}

function rmActions(
    words: readonly string[],
    executableIndex: number,
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): readonly PermissionAction[] {
    const parsed = parseRm(words.slice(executableIndex + 1));
    if (parsed.targets.length === 0) {
        return [{ tool: "bash", verb: "unknown", executable: "rm" }];
    }
    return parsed.targets.map((target) =>
        shellPathAction(
            "delete",
            target,
            "rm",
            workspace,
            workingDirectory,
            homeDirectory,
        )
    );
}

/**
 * A shell word that resolves to a literal path becomes a concrete action.
 * Anything else (variable, command substitution, glob, unknown directory)
 * becomes an `unknown` action rather than a guessed path.
 */
function shellPathAction(
    verb: "write" | "delete",
    target: string,
    executable: string,
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): PermissionAction {
    const path = resolveShellTarget(target, workingDirectory, homeDirectory);
    return path === undefined
        ? { tool: "bash", verb: "unknown", executable }
        : {
            tool: "bash",
            verb,
            path,
            scope: pathScope(path, workspace),
            executable,
        };
}

function permissionReason(
    profile: PermissionProfile,
    decisions: readonly PermissionActionDecision[],
    effective: PermissionOutcome,
): string {
    const matches = decisions
        .filter((decision) => decision.outcome === effective)
        .map((decision) =>
            `${describeAction(decision.action)} (${decision.rule})`
        );
    return `Permission profile ${profile.name} requires ${effective}: ${matches.join(", ")}.`;
}

function isPermissionOutcome(value: unknown): value is PermissionOutcome {
    return value === "allow"
        || value === "review"
        || value === "ask"
        || value === "deny";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeAction(action: PermissionAction): string {
    if (action.operation !== undefined) {
        return action.operation;
    }
    if (action.path !== undefined) {
        return `${action.verb} ${action.path}`;
    }
    return action.executable === undefined
        ? `${action.tool}:${action.verb}`
        : `${action.executable}:${action.verb}`;
}

function pathScope(path: string, workspace: string): PermissionScope {
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
    initialDirectory: string | undefined,
    depth: number,
): string | undefined {
    const commands = tokenizeSimpleCommands(command);
    let workingDirectory = initialDirectory === undefined
        ? undefined
        : resolve(initialDirectory);
    for (const words of commands) {
        const executableIndex = simpleCommandExecutableIndex(words);
        const executable = basename(words[executableIndex] ?? "");
        if (executable === "cd") {
            // A `cd` the guard cannot resolve makes the working directory
            // unknown. The guard refuses only positively recognized targets,
            // so later relative targets stop being recognizable at all.
            workingDirectory = nextWorkingDirectory(
                words,
                workingDirectory,
                homeDirectory,
            );
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
    workingDirectory: string | undefined,
    workspace: string,
    homeDirectory: string,
): string | undefined {
    const broadGlob = isBroadImmediateGlob(target);
    const resolvedTarget = resolveShellTarget(
        broadGlob ? dirname(target) : target,
        workingDirectory,
        homeDirectory,
    );
    if (resolvedTarget === undefined) {
        return undefined;
    }
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

/**
 * Resolves a shell word to an absolute path, or `undefined` when it cannot be
 * resolved statically. Callers turn `undefined` into an `unknown` action.
 */
function resolveShellTarget(
    target: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): string | undefined {
    if (target.length === 0 || hasShellExpansion(target)) {
        return undefined;
    }
    if (target === "~" || target.startsWith("~/")) {
        return resolveShellPath(target, homeDirectory, homeDirectory);
    }
    if (target.startsWith("~")) {
        // `~someone` means that user's home directory, which Vera cannot
        // look up.
        return undefined;
    }
    if (isAbsolute(target)) {
        return resolve(target);
    }
    return workingDirectory === undefined
        ? undefined
        : resolve(workingDirectory, target);
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
