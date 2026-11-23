import { spawn } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
    MAX_FULL_FILE_BYTES,
    MAX_FILE_LIST_READ_BYTES,
    MAX_FILE_LINE_CHANGES,
    MAX_GIT_BRANCHES,
    MAX_GIT_FILES,
    MAX_GIT_PATHS,
    MAX_GIT_SEARCH_BYTES,
    MAX_GIT_SEARCH_MATCHES,
    MAX_GIT_SEARCH_QUERY,
    MAX_GIT_SEARCH_RESULTS,
    GIT_SEARCH_TIMEOUT_MS,
    MAX_PATCH_BYTES,
    MAX_PATCH_FILES,
    MAX_PATCH_LINE_BYTES,
    MAX_PATCH_LINES,
    MAX_UNTRACKED_READ_BYTES,
    validGitPath,
    type GitBranch,
    type GitChangedFile,
    type GitFileList,
    type GitFileStatus,
    type GitPathEntry,
    type GitSearchResult,
    type GitPatchFile,
    type GitPatchTarget,
    type GitScope,
    type GitState,
    type GitTask,
    type GitTaskReply,
    type GitTextFile,
    type GitTextSide,
    type FileLineChange,
} from "./git-wire.ts";

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8_000;

export class GitRefusal extends Error {}

interface GitOutput {
    readonly code: number;
    readonly stdout: Buffer;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly overflow: boolean;
}

interface NameStatusEntry {
    readonly status: GitFileStatus;
    readonly path: string;
    readonly prevPath?: string;
}

interface NumstatEntry {
    readonly added: number | null;
    readonly removed: number | null;
    readonly prevPath?: string;
}

interface ResolvedScope {
    readonly root: string;
    readonly base: string;
    readonly destination: string | null;
    readonly mergeBase: string | null;
    readonly noMergeBase: boolean;
}

export async function runGitTask(task: GitTask): Promise<GitTaskReply> {
    try {
        switch (task.kind) {
            case "state":
                return { kind: "state", ok: true, state: await readGitState(task.folder) };
            case "files":
                return { kind: "files", ok: true, list: await readGitFiles(task.folder, task.scope, task.destination) };
            case "patches":
                return { kind: "patches", ok: true, patches: await readGitPatches(task.folder, task.scope, task.destination, task.files) };
            case "texts":
                return { kind: "texts", ok: true, texts: await readGitTexts(task.folder, task.scope, task.destination, task.file) };
            case "changedLines":
                return { kind: "changedLines", ok: true, changes: await readFileLineChanges(task.folder, task.path) };
            case "paths":
                return { kind: "paths", ok: true, ...await readGitPaths(task.folder) };
            case "search":
                return { kind: "search", ok: true, ...await searchGitFiles(task.folder, task.query) };
        }
    } catch (error) {
        if (error instanceof GitRefusal) return { kind: "failure", ok: false, reason: error.message };
        return { kind: "failure", ok: false, reason: "Could not read the changes." };
    }
}

async function git(
    cwd: string,
    args: readonly string[],
    input = "",
    limits: { readonly outputBytes?: number; readonly timeoutMs?: number } = {},
): Promise<GitOutput> {
    return await new Promise<GitOutput>((resolve, reject) => {
        const child = spawn("git", [
            "--no-pager",
            "-c", "core.quotepath=off",
            "-c", "core.fsmonitor=false",
            "-c", "color.ui=false",
            ...args,
        ], {
            cwd,
            env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_PAGER: "cat",
                GIT_TERMINAL_PROMPT: "0",
                LC_ALL: "C",
                LANG: "C",
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        const errors: string[] = [];
        let size = 0;
        let overflow = false;
        let timedOut = false;
        const timeout = limits.timeoutMs === undefined ? undefined : setTimeout(() => {
            timedOut = true;
            child.kill();
        }, limits.timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => {
            const outputLimit = limits.outputBytes ?? MAX_GIT_OUTPUT_BYTES;
            size += chunk.length;
            if (size > outputLimit) {
                overflow = true;
                const allowed = Math.max(0, outputLimit - (size - chunk.length));
                if (allowed > 0) chunks.push(chunk.subarray(0, allowed));
                child.kill();
                return;
            }
            chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            if (errors.length < 32) errors.push(chunk.toString("utf8"));
        });
        child.on("error", (error) => reject(error));
        child.on("close", (code) => {
            if (timeout !== undefined) clearTimeout(timeout);
            resolve({
                code: overflow || timedOut ? -1 : code ?? -1,
                stdout: Buffer.concat(chunks),
                stderr: errors.join(""),
                timedOut,
                overflow,
            });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
    });
}

function text(output: GitOutput): string {
    return output.stdout.toString("utf8");
}

function ok(output: GitOutput): boolean {
    return output.code === 0;
}

function isBinary(bytes: Buffer): boolean {
    return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function countLines(bytes: Buffer): number {
    if (bytes.length === 0) return 0;
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines += 1;
    if (bytes[bytes.length - 1] !== 10) lines += 1;
    return lines;
}

async function readGitPaths(folder: string): Promise<{ root: string; paths: GitPathEntry[]; truncated: boolean }> {
    const rootRead = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!ok(rootRead)) throw new GitRefusal("This folder is not a git repository.");
    const gitRoot = text(rootRead).trim();
    const canonicalFolder = await realpath(folder).catch(() => null);
    if (canonicalFolder === null) throw new GitRefusal("Could not read the changes.");
    const folderPrefix = relative(gitRoot, canonicalFolder).split(sep).join("/");
    if (folderPrefix === ".." || folderPrefix.startsWith("../") || folderPrefix.startsWith("/")) throw new GitRefusal("Could not read the changes.");
    const [visible, ignored, changed, untracked] = await Promise.all([
        git(gitRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
        git(gitRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
        git(gitRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", "HEAD"]),
        git(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    if (![visible, ignored, changed, untracked].every(ok)) throw new GitRefusal("Could not read the changes.");
    const statuses = new Map(parseNameStatus(text(changed)).map((entry) => [entry.path, entry.status]));
    const untrackedPaths = new Set(splitNul(text(untracked)));
    const rebase = (path: string): string | null => {
        if (folderPrefix === "") return path;
        if (!path.startsWith(`${folderPrefix}/`)) return null;
        return path.slice(folderPrefix.length + 1);
    };
    const isDsStorePath = (path: string): boolean => path.split("/").includes(".DS_Store");
    const entries = new Map<string, GitPathEntry>();
    const visiblePaths = splitNul(text(visible));
    let truncated = false;
    for (const gitPath of visiblePaths) {
        const path = rebase(gitPath);
        if (path === null || isDsStorePath(path)) continue;
        if (entries.size >= MAX_GIT_PATHS) {
            truncated = true;
            break;
        }
        entries.set(path, { path, ignored: false, status: untrackedPaths.has(gitPath) ? "untracked" : statuses.get(gitPath) ?? null });
    }
    for (const gitPath of splitNul(text(ignored))) {
        const path = rebase(gitPath);
        if (path === null || isDsStorePath(path)) continue;
        if (entries.size >= MAX_GIT_PATHS) {
            truncated = true;
            break;
        }
        if (!entries.has(path)) entries.set(path, { path, ignored: true, status: "ignored" });
    }
    return { root: canonicalFolder, paths: [...entries.values()], truncated };
}

async function searchGitFiles(folder: string, query: string): Promise<{ results: GitSearchResult[]; truncated: boolean; timedOut: boolean }> {
    if (query.length === 0 || query.length > MAX_GIT_SEARCH_QUERY) throw new GitRefusal("Could not read the changes.");
    const rootRead = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!ok(rootRead)) throw new GitRefusal("This folder is not a git repository.");
    const root = text(rootRead).trim();
    const canonicalFolder = await realpath(folder).catch(() => null);
    if (canonicalFolder === null) throw new GitRefusal("Could not read the changes.");
    const folderPrefix = relative(root, canonicalFolder).split(sep).join("/");
    if (folderPrefix === ".." || folderPrefix.startsWith("../") || folderPrefix.startsWith("/")) throw new GitRefusal("Could not read the changes.");
    const caseSensitive = /\p{Lu}/u.test(query);
    const output = await git(root, ["grep", "-n", "-I", "-F", "-z", "--no-color", ...(caseSensitive ? [] : ["-i"]), "--untracked", "--exclude-standard", "-e", query, ...(folderPrefix === "" ? [] : ["--", `:(literal)${folderPrefix}/`])], "", {
        outputBytes: MAX_GIT_SEARCH_BYTES,
        timeoutMs: GIT_SEARCH_TIMEOUT_MS,
    });
    if (output.code !== 0 && output.code !== 1 && !output.timedOut && !output.overflow) throw new GitRefusal("Could not read the changes.");
    const byPath = new Map<string, GitSearchResult>();
    const bytes = output.stdout;
    let cursor = 0;
    while (cursor < bytes.length && byPath.size <= MAX_GIT_SEARCH_RESULTS) {
        const pathEnd = bytes.indexOf(0, cursor);
        if (pathEnd < 0) break;
        const gitPath = bytes.subarray(cursor, pathEnd).toString("utf8");
        const path = folderPrefix === "" ? gitPath : gitPath.startsWith(`${folderPrefix}/`) ? gitPath.slice(folderPrefix.length + 1) : "";
        const lineEnd = bytes.indexOf(0, pathEnd + 1);
        if (lineEnd < 0) break;
        const line = Number(bytes.subarray(pathEnd + 1, lineEnd).toString("ascii"));
        const contentEnd = bytes.indexOf(10, lineEnd + 1);
        if (validGitPath(path) && Number.isSafeInteger(line) && line > 0) {
            const current = byPath.get(path);
            byPath.set(path, {
                path,
                matches: Math.min(MAX_GIT_SEARCH_MATCHES, (current?.matches ?? 0) + 1),
                firstLine: current?.firstLine ?? line,
            });
        }
        if (contentEnd < 0) break;
        cursor = contentEnd + 1;
    }
    return {
        results: [...byPath.values()].slice(0, MAX_GIT_SEARCH_RESULTS),
        truncated: output.overflow || byPath.size > MAX_GIT_SEARCH_RESULTS,
        timedOut: output.timedOut,
    };
}

async function readGitState(folder: string): Promise<GitState> {
    const root = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!ok(root)) {
        return {
            folder,
            repo: false,
            root: null,
            branch: null,
            detached: false,
            head: null,
            hasCommits: false,
            branches: [],
            branchesPartial: false,
            upstream: null,
            defaultDestination: null,
        };
    }
    const top = text(root).trim();
    const head = await git(top, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const hasCommits = ok(head);
    const short = hasCommits ? text(await git(top, ["rev-parse", "--short", "HEAD"])).trim() : null;
    const branchRead = await git(top, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const branch = ok(branchRead) ? text(branchRead).trim() : null;
    const { branches, partial: branchesPartial } = await readBranches(top, branch);
    const upstream = await readUpstream(top);
    const originHead = await readOriginHead(top);
    return {
        folder,
        repo: true,
        root: top,
        branch,
        detached: !ok(branchRead),
        head: short === "" ? null : short,
        hasCommits,
        branches,
        branchesPartial,
        upstream,
        defaultDestination: hasCommits ? defaultDestination(branches, branch, upstream, originHead) : null,
    };
}

async function readBranches(root: string, current: string | null): Promise<{ branches: GitBranch[]; partial: boolean }> {
    const output = await git(root, [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%09%(refname)",
        "refs/heads",
        "refs/remotes",
    ]);
    if (!ok(output)) return { branches: [], partial: false };
    const branches: GitBranch[] = [];
    let partial = false;
    for (const line of text(output).split("\n")) {
        if (line === "") continue;
        const tab = line.indexOf("\t");
        const name = tab < 0 ? line : line.slice(0, tab);
        const ref = tab < 0 ? "" : line.slice(tab + 1);
        if (name === "" || name.endsWith("/HEAD")) continue;
        if (ref.startsWith("refs/heads/") && name === current) continue;
        branches.push({ name, remote: ref.startsWith("refs/remotes/") });
        if (branches.length >= MAX_GIT_BRANCHES) {
            partial = true;
            break;
        }
    }
    return { branches, partial };
}

async function readUpstream(root: string): Promise<string | null> {
    const output = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (!ok(output)) return null;
    const name = text(output).trim();
    return name === "" ? null : name;
}

async function readOriginHead(root: string): Promise<string | null> {
    const output = await git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
    if (!ok(output)) return null;
    const name = text(output).trim().replace(/^refs\/remotes\//, "");
    return name === "" ? null : name;
}

function defaultDestination(
    branches: readonly GitBranch[],
    current: string | null,
    upstream: string | null,
    originHead: string | null,
): string | null {
    const names = new Set(branches.map((branch) => branch.name));
    if (upstream !== null && upstream !== current) return upstream;
    if (originHead !== null && originHead !== current && names.has(originHead)) return originHead;
    for (const candidate of ["main", "master"]) {
        if (candidate !== current && names.has(candidate)) return candidate;
    }
    return null;
}

async function resolveScope(folder: string, scope: GitScope, destination: string | null): Promise<ResolvedScope> {
    const root = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!ok(root)) throw new GitRefusal("This folder is not a git repository.");
    const top = text(root).trim();
    const head = await git(top, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!ok(head)) throw new GitRefusal("This repository has no commits yet.");
    const headSha = text(head).trim();
    if (scope === "uncommitted") return { root: top, base: headSha, destination: null, mergeBase: null, noMergeBase: false };
    const state = await readGitState(top);
    const target = destination ?? state.defaultDestination;
    if (target === null) throw new GitRefusal("Choose a destination branch.");
    const resolved = await git(top, ["rev-parse", "--verify", `${target}^{commit}`]);
    if (!ok(resolved)) throw new GitRefusal("That branch is no longer in this repository.");
    const mergeBase = await git(top, ["merge-base", "HEAD", target]);
    if (!ok(mergeBase)) return { root: top, base: headSha, destination: target, mergeBase: null, noMergeBase: true };
    return { root: top, base: text(mergeBase).trim(), destination: target, mergeBase: text(mergeBase).trim(), noMergeBase: false };
}

async function readFileLineChanges(folder: string, path: string): Promise<readonly FileLineChange[] | null> {
    if (!validGitPath(path)) return null;
    const rootResult = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!ok(rootResult)) return null;
    const root = text(rootResult).trim();
    const canonicalFolder = await realpath(folder).catch(() => null);
    if (canonicalFolder === null) return null;
    const repoPath = relative(root, resolve(canonicalFolder, path)).split(sep).join("/");
    if (!validGitPath(repoPath)) return null;
    const pathspec = `:(literal)${repoPath}`;
    const tracked = await git(root, ["ls-files", "--error-unmatch", "--", pathspec]);
    if (!ok(tracked)) {
        const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec]);
        if (!ok(untracked) || !splitNul(text(untracked)).includes(repoPath)) return null;
        const size = await sizeOf(root, repoPath);
        if (size === null) return null;
        const bytes = await readWorktreeHead(root, repoPath, Math.min(size, MAX_FULL_FILE_BYTES));
        if (bytes === undefined) return null;
        const lineCount = countLines(bytes);
        return lineCount === 0 ? [] : [{ kind: "added", start: 1, end: lineCount }];
    }
    const diff = await git(root, [
        "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", "HEAD", "--", pathspec,
    ]);
    if (!ok(diff)) return null;
    const changes: FileLineChange[] = [];
    for (const match of text(diff).matchAll(/^@@ -(?:\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const removed = match[1] === undefined ? 1 : Number(match[1]);
        const newStart = Number(match[2]);
        const added = match[3] === undefined ? 1 : Number(match[3]);
        const changed = Math.min(removed, added);
        if (changed > 0) changes.push({ kind: "changed", start: newStart, end: newStart + changed - 1 });
        if (added > changed) changes.push({ kind: "added", start: newStart + changed, end: newStart + added - 1 });
        if (removed > changed) {
            const gap = newStart + Math.max(added, 1);
            changes.push({ kind: "removed", start: gap, end: gap });
        }
        if (changes.length >= MAX_FILE_LINE_CHANGES) break;
    }
    return changes.slice(0, MAX_FILE_LINE_CHANGES);
}

async function readGitFiles(folder: string, scope: GitScope, destination: string | null): Promise<GitFileList> {
    const resolved = await resolveScope(folder, scope, destination);
    if (resolved.noMergeBase) {
        return { base: resolved.base, destination: resolved.destination, files: [], total: 0, added: 0, removed: 0, totalsPartial: false, noMergeBase: true };
    }
    const range = scope === "branch" ? [resolved.base, "HEAD"] : ["HEAD"];
    const status = await git(resolved.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", ...range]);
    if (!ok(status)) throw new GitRefusal("Could not read the changes.");
    const numstat = await git(resolved.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", ...range]);
    if (!ok(numstat)) throw new GitRefusal("Could not read the changes.");
    const shortstat = await git(resolved.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--shortstat", ...range]);
    if (!ok(shortstat)) throw new GitRefusal("Could not read the changes.");
    const trackedTotals = parseShortstat(text(shortstat));
    const names = parseNameStatus(text(status));
    const numbers = parseNumstat(text(numstat));
    const files: GitChangedFile[] = [];
    const seen = new Set<string>();
    for (const entry of names) {
        if (files.length >= MAX_GIT_FILES) break;
        const number = numbers.get(entry.path);
        files.push({
            path: entry.path,
            ...(entry.prevPath === undefined ? {} : { prevPath: entry.prevPath }),
            status: entry.status,
            added: number?.added ?? null,
            removed: number?.removed ?? null,
            binary: number !== undefined && number.added === null && number.removed === null,
        });
        seen.add(entry.path);
    }
    let total = names.length;
    let addedTotal = trackedTotals.added;
    let removedTotal = trackedTotals.removed;
    let totalsPartial = false;
    if (scope === "uncommitted") {
        const untracked = await git(resolved.root, ["ls-files", "--others", "--exclude-standard", "-z"]);
        if (!ok(untracked)) throw new GitRefusal("Could not read the changes.");
        let readBytes = 0;
        for (const path of splitNul(text(untracked))) {
            if (seen.has(path)) continue;
            seen.add(path);
            total += 1;
            if (files.length >= MAX_GIT_FILES) {
                totalsPartial = true;
                continue;
            }
            const size = await sizeOf(resolved.root, path);
            let added: number | null = 0;
            let binary = false;
            if (size !== null && size > 0) {
                if (readBytes < MAX_FILE_LIST_READ_BYTES) {
                    const bytes = await readWorktreeHead(resolved.root, path, MAX_UNTRACKED_READ_BYTES);
                    if (bytes !== undefined) {
                        readBytes += bytes.length;
                        binary = isBinary(bytes);
                        added = binary || size > bytes.length ? null : countLines(bytes);
                    } else {
                        added = null;
                    }
                } else {
                    added = null;
                }
            }
            if (added === null) totalsPartial = true;
            else addedTotal += added;
            files.push({ path, status: "untracked", added, removed: binary ? null : 0, binary });
        }
    }
    return {
        base: resolved.base,
        destination: resolved.destination,
        files,
        total,
        added: addedTotal,
        removed: removedTotal,
        totalsPartial,
        noMergeBase: false,
    };
}

// Totals for the whole diff, which stay right when the file list is capped.
function parseShortstat(value: string): { added: number; removed: number } {
    const added = /(\d+) insertions?\(\+\)/.exec(value);
    const removed = /(\d+) deletions?\(-\)/.exec(value);
    return {
        added: added === null ? 0 : Number.parseInt(added[1]!, 10),
        removed: removed === null ? 0 : Number.parseInt(removed[1]!, 10),
    };
}

function splitNul(value: string): string[] {
    const parts = value.split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
}

function parseNameStatus(value: string): NameStatusEntry[] {
    const tokens = splitNul(value);
    const entries: NameStatusEntry[] = [];
    let index = 0;
    while (index < tokens.length) {
        const code = tokens[index++];
        if (code === undefined || code === "") continue;
        const letter = code[0];
        if (letter === "R" || letter === "C") {
            const prevPath = tokens[index++];
            const path = tokens[index++];
            if (prevPath === undefined || path === undefined) break;
            entries.push({ status: letter === "R" ? "renamed" : "added", path, prevPath });
            continue;
        }
        const path = tokens[index++];
        if (path === undefined) break;
        entries.push({ status: statusOf(letter), path });
    }
    return entries;
}

function statusOf(letter: string | undefined): GitFileStatus {
    switch (letter) {
        case "A":
            return "added";
        case "D":
            return "deleted";
        case "R":
            return "renamed";
        case "T":
        case "M":
        case "U":
        default:
            return "modified";
    }
}

function parseNumstat(value: string): Map<string, NumstatEntry> {
    const tokens = splitNul(value);
    const entries = new Map<string, NumstatEntry>();
    let index = 0;
    while (index < tokens.length) {
        const head = tokens[index++];
        if (head === undefined || head === "") continue;
        const first = head.indexOf("\t");
        const second = first < 0 ? -1 : head.indexOf("\t", first + 1);
        if (first < 0 || second < 0) break;
        const added = countOf(head.slice(0, first));
        const removed = countOf(head.slice(first + 1, second));
        const rest = head.slice(second + 1);
        if (rest !== "") {
            entries.set(rest, { added, removed });
            continue;
        }
        const prevPath = tokens[index++];
        const path = tokens[index++];
        if (prevPath === undefined || path === undefined) break;
        entries.set(path, { added, removed, prevPath });
    }
    return entries;
}

function countOf(value: string): number | null {
    return value === "-" ? null : Number.parseInt(value, 10);
}

async function sizeOf(root: string, path: string): Promise<number | null> {
    try {
        const found = await lstat(`${root}/${path}`);
        return found.isFile() ? found.size : null;
    } catch {
        return null;
    }
}

// Read only the head of an untracked file: a large one is counted as unknown
// rather than loaded whole.
async function readWorktreeHead(root: string, path: string, limit: number): Promise<Buffer | undefined> {
    let handle;
    try {
        handle = await open(`${root}/${path}`, "r");
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buffer, 0, limit, 0);
        return buffer.subarray(0, bytesRead);
    } catch {
        return undefined;
    } finally {
        await handle?.close();
    }
}

async function readGitPatches(
    folder: string,
    scope: GitScope,
    destination: string | null,
    targets: readonly GitPatchTarget[],
): Promise<GitPatchFile[]> {
    const resolved = await resolveScope(folder, scope, destination);
    if (resolved.noMergeBase) return [];
    if (targets.length > MAX_PATCH_FILES) throw new GitRefusal("Could not read the changes.");
    const patches: GitPatchFile[] = [];
    for (const target of targets) {
        if (!validGitPath(target.path) || (target.prevPath !== undefined && !validGitPath(target.prevPath))) {
            throw new GitRefusal("Could not read the changes.");
        }
        const oldPath = target.prevPath ?? target.path;
        let raw: GitOutput;
        if (target.status === "untracked") {
            raw = await git(resolved.root, [
                "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3",
                "--", "/dev/null", target.path,
            ]);
        } else {
            const range = scope === "branch" ? [resolved.base, "HEAD"] : ["HEAD"];
            raw = await git(resolved.root, [
                "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "-M", ...range,
                "--", oldPath, target.path,
            ]);
        }
        if (raw.code !== 0 && raw.code !== 1) throw new GitRefusal("Could not read the changes.");
        const patch = text(raw);
        const binary = /(^|\n)Binary files /.test(patch);
        const capped = capPatch(patch);
        const oldBytes = target.status === "untracked" || target.status === "added"
            ? null
            : await blobSize(resolved.root, `${resolved.base}:${oldPath}`);
        const newBytes = target.status === "deleted"
            ? null
            : scope === "branch"
                ? await blobSize(resolved.root, `HEAD:${target.path}`)
                : await sizeOf(resolved.root, target.path);
        patches.push({ path: target.path, patch: capped.patch, binary, cut: capped.cut, oldBytes, newBytes });
    }
    return patches;
}

interface CappedPatch {
    readonly patch: string;
    readonly cut: boolean;
}

// Cut at hunk boundaries so a truncated patch still has a shape the parser can
// read; a single hunk over budget is cut by lines.
function capPatch(value: string): CappedPatch {
    if (value.length === 0) return { patch: "", cut: false };
    const lines = value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const prefix: string[] = [];
    const hunks: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines) {
        if (line.startsWith("@@")) {
            current = [line];
            hunks.push(current);
        } else if (current === null) {
            prefix.push(line);
        } else {
            current.push(line);
        }
    }
    if (hunks.length === 0) {
        const capped = capLines(prefix);
        return { patch: capped.lines.join("\n") + "\n", cut: capped.cut };
    }
    const kept: string[][] = [];
    let count = prefix.length;
    let bytes = 0;
    let cut = false;
    for (const hunk of hunks) {
        const size = hunk.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
        if (count + hunk.length > MAX_PATCH_LINES || bytes + size > MAX_PATCH_BYTES) {
            cut = true;
            break;
        }
        kept.push(hunk);
        count += hunk.length;
        bytes += size;
    }
    if (kept.length === 0) {
        const capped = capLines(hunks[0]!);
        return { patch: [...prefix, ...capped.lines].join("\n") + "\n", cut: true };
    }
    if (kept.length < hunks.length) cut = true;
    const capped = capLines([...prefix, ...kept.flat()]);
    return { patch: capped.lines.join("\n") + "\n", cut: cut || capped.cut };
}

function capLines(lines: readonly string[]): { lines: string[]; cut: boolean } {
    const kept: string[] = [];
    let bytes = 0;
    let cut = false;
    for (const line of lines) {
        if (kept.length >= MAX_PATCH_LINES || bytes + Buffer.byteLength(line) > MAX_PATCH_BYTES) {
            cut = true;
            break;
        }
        if (Buffer.byteLength(line) > MAX_PATCH_LINE_BYTES) {
            const shortened = Buffer.from(line).subarray(0, MAX_PATCH_LINE_BYTES).toString("utf8");
            kept.push(shortened);
            bytes += Buffer.byteLength(shortened);
            cut = true;
            break;
        }
        kept.push(line);
        bytes += Buffer.byteLength(line) + 1;
    }
    return { lines: kept, cut };
}

async function blobSize(root: string, expression: string): Promise<number | null> {
    if (expression.includes("\n")) return null;
    const output = await git(root, ["cat-file", "--batch-check"], `${expression}\n`);
    if (!ok(output)) return null;
    const fields = text(output).trim().split(" ");
    const size = Number.parseInt(fields[2] ?? "", 10);
    return Number.isFinite(size) ? size : null;
}

async function readGitTexts(
    folder: string,
    scope: GitScope,
    destination: string | null,
    target: GitPatchTarget,
): Promise<GitTextFile> {
    const resolved = await resolveScope(folder, scope, destination);
    if (!validGitPath(target.path) || (target.prevPath !== undefined && !validGitPath(target.prevPath))) {
        throw new GitRefusal("Could not read the changes.");
    }
    if (resolved.noMergeBase) return { path: target.path, old: null, new: null, oldTooLarge: false, newTooLarge: false };
    const oldPath = target.prevPath ?? target.path;
    const oldSide = target.status === "added" || target.status === "untracked"
        ? { side: null, tooLarge: false }
        : await readTextSide(resolved.root, `${resolved.base}:${oldPath}`, oldPath, null);
    const newSide = target.status === "deleted"
        ? { side: null, tooLarge: false }
        : scope === "branch"
            ? await readTextSide(resolved.root, `HEAD:${target.path}`, target.path, null)
            : await readTextSide(resolved.root, null, target.path, resolved.root);
    return {
        path: target.path,
        old: oldSide.side,
        new: newSide.side,
        oldTooLarge: oldSide.tooLarge,
        newTooLarge: newSide.tooLarge,
    };
}

interface TextSide {
    readonly side: GitTextSide | null;
    readonly tooLarge: boolean;
}

async function readTextSide(root: string, expression: string | null, name: string, worktree: string | null): Promise<TextSide> {
    if (expression !== null) {
        const size = await blobSize(root, expression);
        if (size === null) return { side: null, tooLarge: false };
        if (size > MAX_FULL_FILE_BYTES) return { side: null, tooLarge: true };
    }
    if (expression === null) {
        const size = await sizeOf(root, name);
        if (size === null) return { side: null, tooLarge: false };
        if (size > MAX_FULL_FILE_BYTES) return { side: null, tooLarge: true };
    }
    const bytes = expression === null
        ? await readFile(`${root}/${name}`).catch(() => undefined)
        : await catFile(root, expression);
    if (bytes === undefined) return { side: null, tooLarge: false };
    if (bytes.length > MAX_FULL_FILE_BYTES) return { side: null, tooLarge: true };
    if (isBinary(bytes)) return { side: null, tooLarge: false };
    return {
        side: {
            name,
            contents: bytes.toString("utf8"),
            cacheKey: worktree !== null
                ? `worktree:${name}:${await worktreeKey(root, name)}`
                : `git:${expression ?? name}`,
        },
        tooLarge: false,
    };
}

async function worktreeKey(root: string, path: string): Promise<string> {
    try {
        const found = await lstat(`${root}/${path}`);
        return `${found.size}:${found.mtimeMs}`;
    } catch {
        return "0:0";
    }
}

async function catFile(root: string, expression: string): Promise<Buffer | undefined> {
    const output = await git(root, ["cat-file", "blob", expression]);
    return ok(output) ? output.stdout : undefined;
}
