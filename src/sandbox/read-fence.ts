import { join } from "node:path";
import type { PermissionRule } from "../engine/permissions.ts";

/**
 * Whether a rule asks the sandbox to fence reads: a deny or ask on a read
 * outside the workspace with no path of its own. Other conditions are
 * ignored, which makes the fence wider than the rule and never narrower.
 */
export function fencesReads(rules: readonly PermissionRule[]): boolean {
    return rules.some((rule) =>
        (rule.then === "deny" || rule.then === "ask")
        && rule.when.scope === "outside_workspace"
        && rule.when.path === undefined
        && (rule.when.verb === undefined || rule.when.verb === "read"));
}

// macOS keeps /etc, /tmp and /var as links at the root, and reading a link,
// like listing /private, needs an allow of its own. srt resolves a plain path
// to its target, so a one character class keeps the path itself.
const DARWIN_ROOT_ENTRIES = ["/et[c]", "/tm[p]", "/va[r]", "/privat[e]"];

const DARWIN_SYSTEM = [
    "/bin",
    "/sbin",
    "/usr",
    "/System",
    "/Library",
    "/Applications",
    "/opt",
    "/private/etc",
    "/private/var",
    "/dev",
    ...DARWIN_ROOT_ENTRIES,
];

const LINUX_SYSTEM = [
    "/bin",
    "/sbin",
    "/usr",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/etc",
    "/opt",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/var",
    "/nix",
    "/snap",
];

// Toolchains, package caches and git configuration that commands read from
// the home folder to run at all.
const HOME_TOOLS = [
    ".bun",
    ".cargo",
    ".rustup",
    ".nvm",
    ".volta",
    ".fnm",
    ".pyenv",
    ".rbenv",
    ".asdf",
    ".deno",
    "go",
    ".local/bin",
    ".local/share/mise",
    ".local/share/uv",
    ".npm",
    ".cache",
    ".gitconfig",
    ".config/git",
];

// Read by every macOS process through CoreFoundation.
const DARWIN_HOME_SYSTEM = [
    ".CFUserTextEncoding",
    "Library/Caches",
    "Library/Preferences/.GlobalPreferences*",
    "Library/Preferences/ByHost/.GlobalPreferences.*",
];

/**
 * What a fenced command may still read without being asked about it: the
 * system folders and the toolchains that live in the home folder. The
 * session's own folders are added by the caller.
 */
export function fixedReadable(
    platform: NodeJS.Platform,
    home: string,
): readonly string[] {
    const system = platform === "darwin" ? DARWIN_SYSTEM : LINUX_SYSTEM;
    const tools = platform === "darwin"
        ? [...HOME_TOOLS, ...DARWIN_HOME_SYSTEM]
        : HOME_TOOLS;
    return [...system, ...tools.map((name) => join(home, name))];
}
