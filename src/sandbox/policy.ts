import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SandboxConfig } from "../config/sandbox.ts";
import type { PermissionRule } from "../engine/permissions.ts";
import { normalizePermissionRulePath } from "../engine/permission-rules.ts";
import {
    projectRulesDirectory,
    projectVeraConfigPath,
} from "../project-paths.ts";

export interface SandboxPolicyInput {
    readonly workspace: string;
    /**
     * The platform whose deny spellings to compile. macOS reads a glob in a
     * deny; Linux drops one and binds only literal paths.
     */
    readonly platform: NodeJS.Platform;
    /**
     * Names srt protects from writes, wherever they lie under an anchor:
     * shell startup files, editor folders and the like. srt keeps them at
     * its own package; the manager reads them from there and passes them in.
     */
    readonly protectedFiles: readonly string[];
    readonly protectedDirectories: readonly string[];
    readonly scratchDir?: string;
    /** The command's temp directory; `TMPDIR` or `/tmp` by default. */
    readonly tempDir?: string;
    readonly home?: string;
    /** Absolute paths of the same repository's other checkouts. */
    readonly otherCheckouts: readonly string[];
    /** The shared git directory of a linked worktree; absent in a main checkout. */
    readonly sharedGitDir?: string;
    /**
     * The folder Vera reads the project's `.vera` settings from. It is the
     * session's working folder, which is also the command's workspace; the
     * input exists so a caller that knows they differ can say so.
     */
    readonly projectRoot?: string;
    /**
     * Absolute write denies found by a scan at the manager boundary. Linux
     * needs it because srt scans from the folder its own process runs in,
     * not from the command's workspace.
     */
    readonly scannedWriteDenies?: readonly string[];
    readonly config: SandboxConfig;
    readonly permissionRules: readonly PermissionRule[];
}

export interface SandboxFilesystemPolicy {
    readonly denyRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
}

export interface SandboxNetworkPolicy {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
}

export interface SandboxPolicy {
    readonly filesystem: SandboxFilesystemPolicy;
    /** Absent in mode open: srt then runs without its network filter. */
    readonly network?: SandboxNetworkPolicy;
}

/**
 * One command's sandbox policy. The lists hold literal paths, except the deny
 * lists, where macOS takes a `*` suffix and Linux takes the literal path.
 */
export function compileSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
    const home = input.home ?? homedir();
    const workspace = resolve(input.workspace);
    const scratch = input.scratchDir === undefined
        ? undefined
        : resolve(input.scratchDir);
    const temp = resolve(input.tempDir ?? tmpdir());
    const allowWrite = new Set<string>([workspace, temp]);
    if (scratch !== undefined) allowWrite.add(scratch);
    const denyRead = new Set<string>();
    const denyWrite = new Set<string>();

    // A linked worktree keeps its index, objects and refs in the repository's
    // shared git directory, so git must be able to write there.
    if (input.sharedGitDir !== undefined) {
        allowWrite.add(resolve(input.sharedGitDir));
    }

    // srt anchors its own protected set at the folder its process runs in,
    // which is not the command's folder: the host runs from the Vera home.
    // Compile the same names at the folders that are writable here, or a
    // command can write the hooks and startup files srt means to deny.
    // The first anchor holds the checkout, so its git directory is `.git`
    // beneath it; the second is a git directory itself.
    const anchors = [{ root: workspace, git: ".git" }];
    if (input.sharedGitDir !== undefined) {
        anchors.push({ root: resolve(input.sharedGitDir), git: "" });
    }
    for (const anchor of anchors) {
        addProtected(denyWrite, anchor.root, join(anchor.git, "hooks"), true, input.platform);
        addProtected(denyWrite, anchor.root, join(anchor.git, "config"), false, input.platform);
        for (const name of input.protectedFiles) {
            addProtected(denyWrite, anchor.root, name, false, input.platform);
        }
        for (const name of input.protectedDirectories) {
            addProtected(denyWrite, anchor.root, name, true, input.platform);
        }
    }

    // The project's own Vera settings: the config both readers open and the
    // rules the loader reads. Everything else under `.vera` stays writable.
    const projectRoot = resolve(input.projectRoot ?? workspace);
    addProjectProtected(
        denyWrite,
        projectVeraConfigPath(projectRoot),
        input.platform,
    );
    addProjectProtected(
        denyWrite,
        projectRulesDirectory(projectRoot),
        input.platform,
    );

    for (const scanned of input.scannedWriteDenies ?? []) {
        denyWrite.add(resolve(scanned));
    }

    for (const rule of input.permissionRules) {
        if (rule.then === "allow") {
            const folder = allowedFolder(rule, home);
            if (folder !== undefined) allowWrite.add(folder);
            continue;
        }
        // Deny and ask paths apply whatever their other conditions say, which
        // is wider than the rule and never narrower.
        const path = rule.when.path;
        if (path === undefined) continue;
        const target = normalizePermissionRulePath(path, home);
        if (target === undefined) continue;
        const verb = rule.when.verb;
        if (verb !== "write" && verb !== "delete") denyRead.add(target);
        if (verb !== "read") denyWrite.add(target);
    }

    for (const root of input.otherCheckouts) {
        const checkout = resolve(root);
        if (checkout === workspace) continue;
        // The checkout that holds this workspace is not nested in it, and on
        // Linux denying it also covers its git directory, which a linked
        // worktree must write.
        if (isUnder(workspace, [checkout])) continue;
        if (isUnder(checkout, [...allowWrite])) denyWrite.add(checkout);
    }

    const policy: SandboxPolicy = {
        filesystem: {
            denyRead: [...denyRead],
            allowWrite: [...allowWrite],
            denyWrite: [...denyWrite],
        },
    };
    if (input.config.network === "open") return policy;
    return {
        ...policy,
        network: {
            allowedDomains: [...input.config.allowed_domains],
            deniedDomains: [],
        },
    };
}

/**
 * A folder an allow rule makes writable: a `path` with, at most, a write or
 * delete verb. Any other condition leaves the rule out.
 */
function allowedFolder(rule: PermissionRule, home: string): string | undefined {
    for (const key of Object.keys(rule.when)) {
        if (key !== "path" && key !== "verb") return undefined;
    }
    const path = rule.when.path;
    if (path === undefined) return undefined;
    const verb = rule.when.verb;
    if (verb !== undefined && verb !== "write" && verb !== "delete") {
        return undefined;
    }
    return normalizePermissionRulePath(path, home);
}

/**
 * One protected name at `anchor`: the name itself, plus, on macOS, its
 * pattern beneath the anchor, which is how srt reaches a copy in a
 * subdirectory. Linux drops a pattern and binds literal paths only.
 */
function addProtected(
    denyWrite: Set<string>,
    anchor: string,
    relative: string,
    directory: boolean,
    platform: NodeJS.Platform,
): void {
    denyWrite.add(join(anchor, relative));
    if (platform === "darwin") {
        denyWrite.add(join(anchor, "**", relative, directory ? "**" : ""));
    }
}

function addProjectProtected(
    denyWrite: Set<string>,
    path: string,
    platform: NodeJS.Platform,
): void {
    // macOS filters a literal path only when it exists; the glob also denies
    // creating it. Linux denies by path and covers an absent one.
    denyWrite.add(platform === "darwin" ? `${path}*` : path);
}

function isUnder(path: string, roots: readonly string[]): boolean {
    if (!isAbsolute(path)) return false;
    return roots.some((root) =>
        path === root || path.startsWith(`${root}/`));
}
