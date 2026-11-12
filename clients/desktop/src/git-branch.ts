import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SHORT_SHA_LENGTH = 7;
const REF_PREFIX = "ref: refs/heads/";
const GITDIR_PREFIX = "gitdir:";

// Walks up without running git, so a worktree's `.git` file is followed by hand.
export async function readBranch(folder: string): Promise<string | undefined> {
    try {
        const gitDir = await findGitDir(resolve(folder));
        if (gitDir === undefined) return undefined;
        return parseHead(await readFile(join(gitDir, "HEAD"), "utf8"));
    } catch {
        return undefined;
    }
}

async function findGitDir(start: string): Promise<string | undefined> {
    let current = start;
    for (;;) {
        const candidate = join(current, ".git");
        const found = await statOrUndefined(candidate);
        if (found?.isDirectory()) return candidate;
        if (found?.isFile()) return readGitdirFile(candidate, current);
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

async function statOrUndefined(path: string) {
    try {
        return await stat(path);
    } catch {
        return undefined;
    }
}

async function readGitdirFile(file: string, holder: string): Promise<string | undefined> {
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch {
        return undefined;
    }
    const line = text.trim();
    if (!line.startsWith(GITDIR_PREFIX)) return undefined;
    const target = line.slice(GITDIR_PREFIX.length).trim();
    if (target.length === 0) return undefined;
    return isAbsolute(target) ? target : resolve(holder, target);
}

function parseHead(text: string): string | undefined {
    const line = text.trim();
    if (line.startsWith(REF_PREFIX)) {
        const name = line.slice(REF_PREFIX.length);
        return name.length > 0 ? name : undefined;
    }
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(line)) return line.slice(0, SHORT_SHA_LENGTH);
    return undefined;
}
