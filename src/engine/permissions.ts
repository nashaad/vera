import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "node:path";

import type { HookToolCall } from "../sdk/hooks.ts";
import {
    isApprovalMode,
    parseApprovalMode,
    type ApprovalMode,
    type BuiltInPermissionModeName,
} from "../sdk/permissions.ts";
import {
    nestedShellCommands,
    simpleCommandExecutableIndex,
    tokenizeSimpleCommands,
} from "../tools/bash-danger.ts";
import {
    isBashParserReady,
    parseBashScript,
    type BashCommand,
    type BashRedirect,
    type BashRedirectOperator,
    type BashStatement,
} from "../tools/bash-parser.ts";
import {
    toolPermissionInputs,
    toolPermissionOperation,
} from "../tools/execute.ts";
import type { PermissionInputSpec } from "../tools/types.ts";
import type { RegisteredTool } from "../tools/types.ts";
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

export interface PermissionAction {
    readonly tool: string;
    readonly verb: PermissionVerb;
    readonly path?: string;
    readonly scope?: PermissionScope;
    readonly operation?: string;
    readonly executable?: string;
}

export interface PermissionRequest {
    readonly toolCall: HookToolCall;
    readonly workspace: string;
    readonly homeDirectory: string;
}

export interface PermissionPredicate {
    readonly tool?: string;
    readonly verb?: PermissionVerb;
    readonly path?: string;
    readonly pathGlob?: string;
    readonly scope?: PermissionScope;
    readonly operation?: string;
    readonly executable?: string;
}

export interface PermissionRule {
    readonly name: string;
    readonly when: PermissionPredicate;
    readonly then: PermissionOutcome;
}

export interface PermissionMode {
    readonly name: string;
    readonly rules: readonly PermissionRule[];
    readonly defaultOutcome: PermissionOutcome;
    readonly reviewerProfile?: string;
}

export interface PermissionInspection {
    readonly selected: PermissionMode;
    readonly availableModes: readonly string[];
    readonly activeGrants: readonly PermissionGrant[];
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
    readonly reason?: string;
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
    readonly source: "mode" | "accident_guard";
}

export type ToolPermissionDecision =
    | AllowToolPermission
    | ReviewToolPermission
    | AskToolPermission
    | DenyToolPermission;

export interface DecideToolPermissionOptions {
    readonly homeDirectory?: string;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    readonly permissionPreferences?: readonly PermissionPreference[];
    readonly extensionTools?: readonly RegisteredTool[];
    readonly scratchDir?: string;
}

const SECRET_FILE_HYGIENE_DENY_GLOBS: readonly string[] = [
    ".env",
    "*.pem",
    "id_rsa",
];

const ROUTINE_RULES: readonly PermissionRule[] = [
    ...SECRET_FILE_HYGIENE_DENY_GLOBS.map((glob): PermissionRule => ({
        name: `routine.secret_file_hygiene_deny.${glob}`,
        when: { verb: "read", pathGlob: glob },
        then: "deny",
    })),
    {
        name: "routine.user_interaction",
        when: { tool: "ask_user" },
        then: "allow",
    },
    {
        name: "routine.agent_spawn",
        when: { operation: "agent.spawn" },
        then: "allow",
    },
    {
        name: "routine.agent_message",
        when: { operation: "agent.message" },
        then: "allow",
    },
    {
        name: "routine.agent_close",
        when: { operation: "agent.close" },
        then: "allow",
    },
    {
        name: "routine.agent_inbox",
        when: { operation: "agent.inbox" },
        then: "allow",
    },
    {
        name: "routine.agent_roster",
        when: { operation: "agent.roster" },
        then: "allow",
    },
    {
        name: "routine.process_read",
        when: { operation: "process.read" },
        then: "allow",
    },
    {
        name: "routine.memory_write",
        when: { operation: "memory.write" },
        then: "allow",
    },
    {
        name: "routine.read",
        when: { verb: "read" },
        then: "allow",
    },
    {
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

const READONLY_RULES: readonly PermissionRule[] = [
    ...SECRET_FILE_HYGIENE_DENY_GLOBS.map((glob): PermissionRule => ({
        name: `readonly.secret_file_hygiene_deny.${glob}`,
        when: { verb: "read", pathGlob: glob },
        then: "deny",
    })),
    {
        name: "readonly.bash_deny",
        when: { tool: "bash" },
        then: "deny",
    },
    {
        name: "readonly.user_interaction",
        when: { tool: "ask_user" },
        then: "allow",
    },
    {
        name: "readonly.process_read",
        when: { operation: "process.read" },
        then: "allow",
    },
    {
        name: "readonly.read",
        when: { verb: "read" },
        then: "allow",
    },
];

export const BUILT_IN_PERMISSION_MODES: Readonly<
    Record<BuiltInPermissionModeName, PermissionMode>
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
    readonly: {
        name: "readonly",
        rules: READONLY_RULES,
        defaultOutcome: "deny",
    },
};

const OUTCOME_WEIGHT: Readonly<Record<PermissionOutcome, number>> = {
    allow: 0,
    review: 1,
    ask: 2,
    deny: 3,
};

type ReadOnlyClassifier = (args: readonly string[]) => boolean;

function alwaysReadOnly(): boolean {
    return true;
}

function excludingDangerousFlags(flags: readonly string[]): ReadOnlyClassifier {
    return (args) => !args.some((word) => flags.some((flag) => matchesFlag(word, flag)));
}

function matchesFlag(word: string, flag: string): boolean {
    if (word === flag) {
        return true;
    }
    if (word.startsWith("--")) {
        const separator = word.indexOf("=");
        return separator > 0 && word.slice(0, separator) === flag;
    }
    if (flag.startsWith("--") || !word.startsWith("-") || word.length <= 1) {
        return false;
    }
    return word.slice(1).includes(flag.slice(1));
}

function matchingSubcommand(subcommands: readonly string[]): ReadOnlyClassifier {
    return (args) => subcommands.includes(args[0] ?? "");
}

function boundedSleep(args: readonly string[]): boolean {
    if (args.length !== 1) return false;
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(args[0] ?? "");
    if (match === null) return false;
    const value = Number(match[1]);
    const multiplier = {
        "": 1,
        s: 1,
        m: 60,
        h: 60 * 60,
        d: 24 * 60 * 60,
    }[match[2] ?? ""];
    return Number.isFinite(value)
        && multiplier !== undefined
        && value * multiplier <= 5 * 60;
}

function readingDate(args: readonly string[]): boolean {
    return args.length === 0
        || args.every((arg) => arg.startsWith("+"));
}

const READ_ONLY_COMMANDS: Readonly<Record<string, ReadOnlyClassifier>> = {
    cat: alwaysReadOnly,
    head: alwaysReadOnly,
    tail: alwaysReadOnly,
    wc: alwaysReadOnly,
    pwd: alwaysReadOnly,
    stat: alwaysReadOnly,
    ls: alwaysReadOnly,
    grep: alwaysReadOnly,
    sleep: boundedSleep,
    date: readingDate,
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

const GIT_READ_SUBCOMMANDS = new Set(["log", "status", "diff", "show"]);

export const CORE_PERMISSION_OPERATIONS = new Set([
    "agent.close",
    "agent.inbox",
    "agent.message",
    "agent.roster",
    "agent.spawn",
    "git.clone",
    "git.commit",
    "git.fetch",
    "git.ls_remote",
    "git.pull",
    "git.push",
    "git.remote_update",
    "memory.write",
    "process.kill",
    "process.read",
    "web.fetch",
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

    const permissionMode = builtInPermissionMode(mode)
        ?? options.permissionModes?.[mode];
    if (permissionMode === undefined) {
        return {
            behavior: "deny",
            reason: `Permission mode ${mode} is unavailable.`,
            actions: [],
            source: "mode",
        };
    }
    const decisions = extractPermissionActions({
        toolCall,
        workspace,
        homeDirectory,
    }, options.extensionTools).map((action) =>
        rescopeScratchAction(action, options.scratchDir)
    ).map((action) =>
        evaluateAction(
            permissionMode,
            action,
            grants,
            options.permissionPreferences ?? [],
        )
    );
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

    const reason = permissionReason(permissionMode, decisions, effective);
    if (effective === "review") {
        if (permissionMode.reviewerProfile === undefined) {
            return {
                behavior: "deny",
                reason: `Permission mode ${permissionMode.name} routes to review but has no reviewer profile.`,
                actions: decisions,
                source: "mode",
            };
        }
        return {
            behavior: "review",
            reason,
            actions: decisions,
            reviewerProfile: permissionMode.reviewerProfile,
        };
    }
    if (effective === "ask") {
        return { behavior: "ask", reason, actions: decisions };
    }
    return {
        behavior: "deny",
        reason,
        actions: decisions,
        source: "mode",
    };
}

export function stricterToolPermission(
    child: ToolPermissionDecision,
    parent: ToolPermissionDecision,
): ToolPermissionDecision {
    return BEHAVIOR_WEIGHT[parent.behavior] > BEHAVIOR_WEIGHT[child.behavior]
        ? parent
        : child;
}

const BEHAVIOR_WEIGHT: Readonly<
    Record<ToolPermissionDecision["behavior"], number>
> = {
    allow: 0,
    review: 1,
    ask: 2,
    deny: 3,
};

export const BUILT_IN_PERMISSION_MODE_NAMES: readonly string[] = [
    "readonly",
    "ask",
    "auto",
    "full_access",
];

export function builtInPermissionMode(
    name: string,
): PermissionMode | undefined {
    return name === "readonly" || name === "ask" || name === "auto"
            || name === "full_access"
        ? BUILT_IN_PERMISSION_MODES[name]
        : undefined;
}

export function inspectPermissions(
    name: ApprovalMode,
    customModes: Readonly<Record<string, PermissionMode>> = {},
    grants: readonly PermissionGrant[] = [],
    preferences: readonly PermissionPreference[] = [],
): PermissionInspection | undefined {
    const selected = builtInPermissionMode(name) ?? customModes[name];
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
        availableModes: [
            ...Object.keys(BUILT_IN_PERMISSION_MODES),
            ...Object.keys(customModes),
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
        && Array.isArray(value.availableModes)
        && value.availableModes.every((name) =>
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
    extensionTools: readonly RegisteredTool[] = [],
): readonly PermissionAction[] {
    const { toolCall, workspace } = request;
    const actions: PermissionAction[] = [];
    const operation = toolPermissionOperation(toolCall.name, extensionTools);
    if (operation !== undefined) {
        actions.push({
            tool: toolCall.name,
            verb: "unknown",
            operation,
        });
    }
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
    if (toolCall.name === "process") {
        if (toolCall.input.action === "read") {
            return [{
                tool: "process",
                verb: "read",
                operation: "process.read",
            }];
        }
        if (toolCall.input.action === "kill") {
            return [{
                tool: "process",
                verb: "unknown",
                operation: "process.kill",
            }];
        }
        return [{ tool: "process", verb: "unknown" }];
    }

    const declaredInputs = toolPermissionInputs(toolCall.name, extensionTools);
    if (declaredInputs === undefined || declaredInputs.length === 0) {
        return actions.length === 0
            ? [{ tool: toolCall.name, verb: "unknown" }]
            : actions;
    }
    return [
        ...actions,
        ...declaredInputs.map((spec) =>
            structuredInputAction(toolCall, spec, workspace)
        ),
    ];
}

export function evaluateAction(
    mode: PermissionMode,
    action: PermissionAction,
    grants: readonly PermissionGrant[] = [],
    preferences: readonly PermissionPreference[] = [],
): PermissionActionDecision {
    // Process IDs are session-scoped by the host registry, so this can only reduce authority the same session already holds.
    if (action.operation === "process.kill") {
        return {
            action,
            outcome: "allow",
            rule: "core.process_kill",
        };
    }
    for (const rule of mode.rules) {
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
        outcome: mode.defaultOutcome,
        rule: `${mode.name}.default`,
    }, preferences, grants);
}

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

function structuredInputAction(
    toolCall: HookToolCall,
    spec: PermissionInputSpec,
    workspace: string,
): PermissionAction {
    const raw = toolCall.input[spec.field];
    if (typeof raw !== "string") {
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
    if (raw.length === 0 && spec.verb !== "read") {
        return { tool: toolCall.name, verb: "unknown" };
    }
    const path = resolve(workspace, raw || ".");
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
    if (!isBashParserReady()) {
        return [{ tool: "bash", verb: "unknown" }];
    }
    const script = parseBashScript(command);
    if (script.statements.length === 0) {
        return command.trim().length === 0 ? [] : [{
            tool: "bash",
            verb: "unknown",
        }];
    }

    const walk = new BashActionWalk(workspace, homeDirectory, initialDirectory);
    for (const statement of script.statements) {
        walk.visit(statement);
    }

    const nested = [
        ...script.substitutions,
        ...shellCommandPayloads(script.commands),
    ];
    if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return nested.length === 0
            ? walk.actions
            : [...walk.actions, { tool: "bash", verb: "unknown" }];
    }
    return [
        ...walk.actions,
        ...nested.flatMap((source) =>
            extractBashActions(
                source,
                workspace,
                homeDirectory,
                walk.workingDirectory,
                depth + 1,
            )
        ),
    ];
}

class BashActionWalk {
    readonly actions: PermissionAction[] = [];
    workingDirectory: string | undefined;

    constructor(
        private readonly workspace: string,
        private readonly homeDirectory: string,
        initialDirectory: string | undefined,
    ) {
        this.workingDirectory = initialDirectory;
    }

    visit(statement: BashStatement): void {
        if (statement.kind === "command") {
            this.visitCommand(statement);
            return;
        }
        if (statement.kind === "chain") {
            this.visit(statement.left);
            this.visit(statement.right);
            return;
        }
        if (statement.kind === "pipeline") {
            const before = this.workingDirectory;
            for (const stage of statement.stages) {
                this.workingDirectory = before;
                this.visit(stage);
            }
            this.workingDirectory = before;
            return;
        }
        this.actions.push({ tool: "bash", verb: "unknown" });
        this.workingDirectory = undefined;
    }

    private visitCommand(command: BashCommand): void {
        this.actions.push(
            ...actionsForSimpleCommand(
                command,
                this.workspace,
                this.workingDirectory,
                this.homeDirectory,
            ),
        );
        this.workingDirectory = command.hasNonLiteralWords
                && basename(command.words[0] ?? "") === "cd"
            ? undefined
            : nextWorkingDirectory(
                command.words,
                this.workingDirectory,
                this.homeDirectory,
            );
    }
}

function shellCommandPayloads(
    commands: readonly BashCommand[],
): readonly string[] {
    const payloads: string[] = [];
    for (const { words } of commands) {
        const executableIndex = simpleCommandExecutableIndex(words);
        const executable = basename(words[executableIndex] ?? "");
        if (!NESTED_SHELLS.has(executable)) {
            continue;
        }
        const flagIndex = words.findIndex((word, index) =>
            index > executableIndex && /^-[^-]*c/.test(word)
        );
        const payload = flagIndex === -1 ? undefined : words[flagIndex + 1];
        if (payload !== undefined) {
            payloads.push(payload);
        }
    }
    return payloads;
}

const NESTED_SHELLS = new Set(["bash", "sh", "zsh"]);

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
    command: BashCommand,
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): readonly PermissionAction[] {
    const { words } = command;
    const executableIndex = simpleCommandExecutableIndex(words);
    const executable = basename(words[executableIndex] ?? "");
    const redirects = redirectActions(
        command.redirects,
        workspace,
        workingDirectory,
        homeDirectory,
    );
    if (executable.length === 0) {
        return [{ tool: "bash", verb: "unknown" }, ...redirects];
    }
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
    const writeCommand = FILE_WRITE_COMMANDS[executable];
    if (writeCommand !== undefined) {
        if (command.hasNonLiteralWords) {
            return [
                { tool: "bash", verb: "unknown", executable },
                ...redirects,
            ];
        }
        return [
            ...writeCommandActions(
                writeCommand,
                words,
                executableIndex,
                executable,
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
        && !command.hasNonLiteralWords
        && readOnlyClassifier(words.slice(executableIndex + 1))
    ) {
        return [{ tool: "bash", verb: "read", executable }, ...redirects];
    }
    if (REDIRECT_ONLY_COMMANDS.has(executable)) {
        return redirects.length === 0
            ? [{ tool: "bash", verb: "read", executable }]
            : redirects;
    }
    return [{ tool: "bash", verb: "unknown", executable }, ...redirects];
}

const INERT_REDIRECT_TARGETS = new Set([
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/stdin",
]);

function isInertRedirectTarget(target: string): boolean {
    return INERT_REDIRECT_TARGETS.has(target);
}

const WRITING_REDIRECT_OPERATORS = new Set<BashRedirectOperator>([
    ">",
    ">>",
    "&>",
    "&>>",
]);

function isWritingRedirect(redirect: BashRedirect): boolean {
    if (WRITING_REDIRECT_OPERATORS.has(redirect.operator)) {
        return true;
    }
    if (redirect.operator !== ">&") {
        return false;
    }
    return redirect.target === undefined
        || !/^\d+-?$/.test(redirect.target);
}

function redirectActions(
    redirects: readonly BashRedirect[],
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): readonly PermissionAction[] {
    const actions: PermissionAction[] = [];
    for (const redirect of redirects) {
        if (!isWritingRedirect(redirect)) {
            continue;
        }
        if (redirect.target === undefined) {
            actions.push({
                tool: "bash",
                verb: "unknown",
                executable: "shell_redirect",
            });
            continue;
        }
        if (isInertRedirectTarget(redirect.target)) {
            actions.push({
                tool: "bash",
                verb: "read",
                executable: "shell_redirect",
            });
            continue;
        }
        actions.push(shellPathAction(
            "write",
            redirect.target,
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

const FILE_WRITE_COMMANDS: Record<string, WriteCommandSpec | undefined> = {
    cp: { operands: "copy", flagsWithValues: ["-t", "--target-directory"] },
    mv: {
        operands: "copy",
        consumesSources: true,
        flagsWithValues: ["-t", "--target-directory"],
    },
    touch: {
        operands: "targets",
        flagsWithValues: ["-r", "-d", "-t", "--reference", "--date"],
    },
    mkdir: { operands: "targets", flagsWithValues: ["-m", "--mode"] },
};

type WriteCommandSpec = {
    readonly operands: "targets" | "copy";
    readonly consumesSources?: boolean;
    readonly flagsWithValues: readonly string[];
};

function writeCommandActions(
    spec: WriteCommandSpec,
    words: readonly string[],
    executableIndex: number,
    executable: string,
    workspace: string,
    workingDirectory: string | undefined,
    homeDirectory: string,
): readonly PermissionAction[] {
    const unknown = [{ tool: "bash", verb: "unknown", executable }] as const;
    const operands = parseWriteCommandOperands(
        words.slice(executableIndex + 1),
        spec.flagsWithValues,
    );
    if (operands === undefined) {
        return unknown;
    }
    const action = (verb: "read" | "write" | "delete", target: string) =>
        verb === "read"
            ? { tool: "bash", verb, executable } as const
            : shellPathAction(
                verb,
                target,
                executable,
                workspace,
                workingDirectory,
                homeDirectory,
            );
    if (spec.operands === "targets") {
        return operands.length === 0
            ? unknown
            : operands.map((target) => action("write", target));
    }
    const destination = operands.at(-1);
    if (operands.length < 2 || destination === undefined) {
        return unknown;
    }
    const sources = operands.slice(0, -1);
    return [
        ...sources.flatMap((source) =>
            spec.consumesSources === true
                ? [action("read", source), action("delete", source)]
                : [action("read", source)]
        ),
        action("write", destination),
    ];
}

function parseWriteCommandOperands(
    words: readonly string[],
    flagsWithValues: readonly string[],
): readonly string[] | undefined {
    const operands: string[] = [];
    let optionsEnded = false;
    for (const word of words) {
        if (!optionsEnded && word === "--") {
            optionsEnded = true;
            continue;
        }
        if (!optionsEnded && word.startsWith("-") && word.length > 1) {
            if (
                flagsWithValues.some((flag) =>
                    word === flag
                    || word.startsWith(`${flag}=`)
                    || (!flag.startsWith("--")
                        && !word.startsWith("--")
                        && word.includes(flag.slice(1)))
                )
            ) {
                return undefined;
            }
            continue;
        }
        operands.push(word);
    }
    return operands;
}

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
    mode: PermissionMode,
    decisions: readonly PermissionActionDecision[],
    effective: PermissionOutcome,
): string {
    const matches = decisions
        .filter((decision) => decision.outcome === effective)
        .map((decision) =>
            `${describeAction(decision.action)} (${decision.rule})`
        );
    return `Permission mode ${mode.name} requires ${effective}: ${matches.join(", ")}.`;
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

function rescopeScratchAction(
    action: PermissionAction,
    scratchDir: string | undefined,
): PermissionAction {
    if (
        scratchDir === undefined
        || action.path === undefined
        || action.scope !== "outside_workspace"
    ) {
        return action;
    }
    const root = resolve(scratchDir);
    return action.path === root || action.path.startsWith(`${root}${sep}`)
        ? { ...action, scope: "workspace" }
        : action;
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
