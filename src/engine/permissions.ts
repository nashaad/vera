import { basename, resolve, sep } from "node:path";

import type { HookToolCall } from "../sdk/hooks.ts";
import {
    containsRecursiveForceRm,
    nestedShellCommands,
    simpleCommandExecutableIndex,
    tokenizeSimpleCommands,
} from "../tools/bash-danger.ts";

export type ApprovalMode = "ask" | "approve_for_me" | "full_access";

export interface AllowToolPermission {
    readonly behavior: "allow";
}

export interface AskToolPermission {
    readonly behavior: "ask";
    readonly reason: string;
}

export interface DenyToolPermission {
    readonly behavior: "deny";
    readonly reason: string;
}

export type ToolPermissionDecision =
    | AllowToolPermission
    | AskToolPermission
    | DenyToolPermission;

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

const NETWORK_GIT_COMMANDS = new Set([
    "clone",
    "fetch",
    "ls-remote",
    "pull",
    "push",
]);

const LOCAL_PACKAGE_COMMANDS = new Map<string, ReadonlySet<string>>([
    ["brew", new Set(["list"])],
    ["bun", new Set(["run", "test"])],
    ["cargo", new Set(["build", "check", "clippy", "fmt", "run", "test"])],
    ["go", new Set(["build", "fmt", "run", "test", "vet"])],
    ["npm", new Set(["run", "start", "test"])],
    ["pip", new Set(["check", "freeze", "list", "show"])],
    ["pip3", new Set(["check", "freeze", "list", "show"])],
    ["pnpm", new Set(["run", "start", "test"])],
    ["uv", new Set(["run"])],
    ["yarn", new Set(["run", "start", "test"])],
]);

const NETWORK_ONLY_COMMANDS = new Set(["npx", "pipx"]);

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
): ToolPermissionDecision {
    if (toolCall.name !== "bash") {
        return { behavior: "allow" };
    }

    const command = toolCall.input.command;
    if (typeof command !== "string") {
        return { behavior: "allow" };
    }

    if (containsRecursiveForceRm(command)) {
        return {
            behavior: "deny",
            reason: "Blocked dangerous command: recursive-force rm is not allowed",
        };
    }
    if (mode === "full_access") {
        return { behavior: "allow" };
    }
    if (mode === "ask") {
        return {
            behavior: "ask",
            reason: "Bash commands run with your full user permissions.",
        };
    }
    if (likelyUsesNetwork(command)) {
        return {
            behavior: "ask",
            reason: "This command may access the network.",
        };
    }
    if (likelyAccessesOutsideWorkspace(command, workspace)) {
        return {
            behavior: "ask",
            reason: "This command may access a path outside the workspace.",
        };
    }
    return { behavior: "allow" };
}

function likelyUsesNetwork(command: string, depth = 0): boolean {
    const commands = tokenizeSimpleCommands(command);
    const direct = commands.some((words) => {
        const executableIndex = simpleCommandExecutableIndex(words);
        const executable = basename(words[executableIndex] ?? "");
        if (NETWORK_COMMANDS.has(executable)) {
            return true;
        }
        if (executable === "git") {
            return likelyNetworkGitCommand(words, executableIndex);
        }
        if (NETWORK_ONLY_COMMANDS.has(executable)) {
            return true;
        }
        const localSubcommands = LOCAL_PACKAGE_COMMANDS.get(executable);
        return localSubcommands !== undefined
            && !localSubcommands.has(words[executableIndex + 1] ?? "");
    });
    if (direct || depth >= MAX_NESTED_SHELL_DEPTH) {
        return direct;
    }
    return nestedShellCommands(command, commands).some((nested) =>
        likelyUsesNetwork(nested, depth + 1)
    );
}

function likelyNetworkGitCommand(
    words: readonly string[],
    executableIndex: number,
): boolean {
    const subcommandIndex = gitSubcommandIndex(words, executableIndex + 1);
    const subcommand = words[subcommandIndex];
    if (NETWORK_GIT_COMMANDS.has(subcommand ?? "")) {
        return true;
    }
    return subcommand === "remote" && words[subcommandIndex + 1] === "update";
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

function likelyAccessesOutsideWorkspace(
    command: string,
    workspace: string,
    depth = 0,
): boolean {
    const commands = tokenizeSimpleCommands(command);
    const direct = commands.some((words) => {
        const executableIndex = simpleCommandExecutableIndex(words);
        return words.slice(executableIndex + 1).some((word) =>
            wordPointsOutsideWorkspace(word, workspace)
        );
    });
    if (direct || depth >= MAX_NESTED_SHELL_DEPTH) {
        return direct;
    }
    return nestedShellCommands(command, commands).some((nested) =>
        likelyAccessesOutsideWorkspace(
            nested,
            workspace,
            depth + 1,
        )
    );
}

function wordPointsOutsideWorkspace(word: string, workspace: string): boolean {
    const value = pathLikePart(word);
    if (
        value.startsWith("~")
        || value.startsWith("$HOME")
        || value.startsWith("${HOME}")
        || value.startsWith("$PWD/..")
        || value.startsWith("${PWD}/..")
    ) {
        return true;
    }
    if (
        value !== ".."
        && !value.startsWith("../")
        && !value.startsWith("/")
    ) {
        return false;
    }

    const root = resolve(workspace);
    const candidate = resolve(root, value);
    return candidate !== root && !candidate.startsWith(`${root}${sep}`);
}

function pathLikePart(word: string): string {
    const withoutRedirect = word.replace(/^\d*[<>]+/, "");
    const equalsIndex = withoutRedirect.indexOf("=");
    return equalsIndex === -1
        ? withoutRedirect
        : withoutRedirect.slice(equalsIndex + 1);
}
