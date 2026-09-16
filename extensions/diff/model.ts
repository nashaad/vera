import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";

const execute = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_BYTES = 1024 * 1024;

export interface ChangedFile {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
    untracked: boolean;
    notice?: string;
}

export interface WorkspaceDiff {
    root: string;
    base: string;
    files: ChangedFile[];
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
    const result = await execute("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
        cwd, signal, encoding: "utf8", maxBuffer: 4 * MAX_BYTES, timeout: 10_000,
    });
    return result.stdout;
}

async function untrackedContent(root: string, path: string): Promise<{ text?: string; notice?: string; binary: boolean }> {
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return { text: await readlink(absolute), binary: false };
    if (!stat.isFile()) return { notice: "Not a regular file. No text preview.", binary: false };
    if (stat.size > MAX_BYTES) return { notice: "File exceeds the 1 MiB preview limit.", binary: false };
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) return { notice: "Binary file. No text preview.", binary: true };
    return { text: bytes.toString("utf8"), binary: false };
}

export async function readWorkspaceDiff(workspace: string, signal: AbortSignal): Promise<WorkspaceDiff> {
    let root: string;
    try {
        root = (await git(workspace, ["rev-parse", "--show-toplevel"], signal)).trimEnd();
    } catch (error) {
        signal.throwIfAborted();
        throw new Error("This workspace is not an accessible Git repository.", { cause: error });
    }
    let base = "HEAD";
    try { await git(root, ["rev-parse", "--verify", "HEAD"], signal); }
    catch { signal.throwIfAborted(); base = EMPTY_TREE; }
    const [statusText, statsText] = await Promise.all([
        git(root, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
        git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, "--"], signal),
    ]);
    const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    for (const entry of statsText.split("\0").filter(Boolean)) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry);
        if (!match) continue;
        stats.set(match[3]!, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0, binary: match[1] === "-" });
    }
    const files: ChangedFile[] = [];
    for (const entry of statusText.split("\0").filter(Boolean)) {
        signal.throwIfAborted();
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        const untracked = code === "??";
        const counts = stats.get(path);
        if (!untracked && counts === undefined && !code.includes("U")) continue;
        const status = untracked ? "Untracked" : code.includes("U") || code === "AA" || code === "DD" ? "Conflict"
            : code.includes("D") ? "Deleted" : code.includes("A") ? "Added" : "Modified";
        const file: ChangedFile = { path, status, untracked, additions: 0, deletions: 0, binary: false, ...counts };
        if (untracked) {
            try {
                const content = await untrackedContent(root, path);
                file.binary = content.binary;
                file.notice = content.notice;
                const text = content.text ?? "";
                file.additions = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
            } catch { file.notice = "File could not be read. Reopen /diff to refresh."; }
        }
        files.push(file);
    }
    return { root, base, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function readFilePatch(snapshot: WorkspaceDiff, file: ChangedFile, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (file.untracked) {
        const content = await untrackedContent(snapshot.root, file.path);
        signal.throwIfAborted();
        return content.text === undefined ? content.notice ?? "No text preview."
            : createTwoFilesPatch("/dev/null", file.path, "", content.text, "", "", { context: 12 });
    }
    const patch = await git(snapshot.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=12", snapshot.base, "--", file.path], signal);
    return patch || "No changes against HEAD. Reopen /diff to refresh.";
}

export function fileCounts(file: ChangedFile): string {
    return file.binary ? "binary" : file.notice ? "preview unavailable" : `+${file.additions} -${file.deletions}`;
}

export function patchDocument(file: ChangedFile, patch: string): string {
    const fence = "`".repeat(Math.max(3, ...[...patch.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return `${file.status} · ${fileCounts(file)}\n\n${fence}diff\n${patch}\n${fence}`;
}
