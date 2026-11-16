import { chmodSync, lstatSync, mkdirSync } from "node:fs";

const ASSIGNMENT = /(?:^|\s)TMPDIR=(?:'([^']*)'|"([^"]*)"|([^\s;]+))/;

/**
 * The temp folder srt points a covered command at, read from the argv it
 * answers with. macOS prefixes an `env` assignment; Linux passes it as
 * `--setenv TMPDIR <value>`. The name belongs to srt and is not repeated here.
 */
export function sandboxTmpDir(argv: readonly string[]): string | undefined {
    for (let index = 0; index < argv.length; index++) {
        const part = argv[index];
        if (part === undefined) continue;
        if (part === "--setenv" && argv[index + 1] === "TMPDIR") {
            return argv[index + 2];
        }
        const match = ASSIGNMENT.exec(part);
        if (match !== null) return match[1] ?? match[2] ?? match[3];
    }
    return undefined;
}

/**
 * Creates the folder owner-only. Returns why it cannot be used: another
 * user's folder, a symlink, or a path that is not a directory all count.
 */
export function ensureOwnerOnlyDirectory(path: string): string | undefined {
    try {
        const existing = inspect(path);
        if (existing !== undefined) return existing;
        try {
            mkdirSync(path, { recursive: true, mode: 0o700 });
        } catch (error) {
            return messageOf(error);
        }
        // Re-read after creating: another process may have won the race and
        // left something this account does not own.
        const created = inspect(path);
        if (created !== undefined) return created;
        chmodSync(path, 0o700);
        return undefined;
    } catch (error) {
        return messageOf(error);
    }
}

function inspect(path: string): string | undefined {
    let stat;
    try {
        stat = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return messageOf(error);
    }
    if (stat.isSymbolicLink()) return `${path} is a symbolic link`;
    if (!stat.isDirectory()) return `${path} is not a directory`;
    if (
        typeof process.getuid === "function"
        && stat.uid !== process.getuid()
    ) {
        return `${path} belongs to another user`;
    }
    return undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
