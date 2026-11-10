import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const SCRIPT_ROOT = resolve(import.meta.dir, "..", "..");

interface BackupFile {
    readonly source: string;
    readonly destination: string;
    readonly label: string;
}

interface BackupTree {
    readonly source: string;
    readonly destination: string;
}

const BACKUP_FILES: readonly BackupTree[] = [
    { source: "AGENTS.local.md", destination: "AGENTS.local.md" },
    { source: "CLAUDE.md", destination: "CLAUDE.md" },
    { source: ".claude/settings.json", destination: ".claude/settings.json" },
    {
        source: ".claude/settings.local.json",
        destination: ".claude/settings.local.json",
    },
];

// .agent-notes lands in agent-notes/, the name of the backup folder users see.
const BACKUP_TREES: readonly BackupTree[] = [
    { source: ".agent-notes", destination: "agent-notes" },
    { source: ".vera/rules", destination: ".vera/rules" },
    { source: ".claude/rules", destination: ".claude/rules" },
];

const IGNORED_NAME = ".DS_Store";

async function main(): Promise<void> {
    if (process.argv.includes("--auto")) {
        await autoSync();
        return;
    }

    try {
        if (process.argv.includes("--check")) {
            await checkBackups();
        } else if (process.argv.includes("--prune")) {
            await pruneBackups();
        } else {
            await syncBackups();
        }
    } catch (error) {
        console.error(messageOf(error));
        process.exitCode = 1;
    }
}

async function checkBackups(): Promise<void> {
    const backupRoot = configuredBackupRoot();
    const failures: string[] = [];
    const stale = await staleBackups(sourceRoot(), backupRoot, failures);
    if (stale.length === 0 && failures.length === 0) {
        console.log("Agent backups are current.");
        return;
    }

    if (stale.length > 0) {
        console.error(`Agent backups are stale: ${stale.join(", ")}`);
    }
    for (const failure of failures) {
        console.error(failure);
    }
    process.exitCode = 1;
}

async function syncBackups(): Promise<void> {
    const backupRoot = configuredBackupRoot();
    const failures: string[] = [];
    const files = await backupFiles(sourceRoot(), backupRoot, failures);
    const updated: string[] = [];

    for (const file of files) {
        try {
            if (await filesMatch(file.source, file.destination)) {
                continue;
            }

            await atomicCopy(file.source, file.destination);
            updated.push(file.label);
        } catch (error) {
            failures.push(`${file.label}: ${messageOf(error)}`);
        }
    }

    if (updated.length > 0) {
        console.log(`Updated agent backups: ${updated.join(", ")}`);
    } else if (failures.length === 0) {
        console.log("Agent backups are current.");
    }

    for (const failure of failures) {
        console.error(failure);
    }
    if (failures.length > 0) {
        process.exitCode = 1;
    }
}

// Every failure here is swallowed: a commit must never fail or wait on it.
async function autoSync(): Promise<void> {
    try {
        const backupRoot = process.env.VERA_AGENT_BACKUP_DIR;
        if (backupRoot === undefined || backupRoot.trim() === "") {
            return;
        }

        const root = resolve(backupRoot);
        if (!await isDirectory(root)) {
            return;
        }

        const failures: string[] = [];
        const files = await backupFiles(sourceRoot(), root, failures);
        for (const file of files) {
            try {
                if (await filesMatch(file.source, file.destination)) {
                    continue;
                }

                await atomicCopy(file.source, file.destination);
            } catch {
                // An unwritable destination must not stop the remaining files.
            }
        }
    } catch (error) {
        console.error(
            `Agent backup failed: ${messageOf(error).replace(/\s+/g, " ")}`,
        );
    }
}

async function pruneBackups(): Promise<void> {
    const backupRoot = configuredBackupRoot();
    const root = sourceRoot();
    const removed: string[] = [];

    for (const tree of BACKUP_TREES) {
        const sourceDirectory = join(root, tree.source);
        const sourceFiles = await findFiles(
            sourceDirectory,
            [],
            tree.source,
        );
        if (sourceFiles.length === 0) {
            continue;
        }

        const sourcePaths = new Set(sourceFiles.map((file) =>
            relative(sourceDirectory, file)
        ));
        const backupDirectory = join(backupRoot, tree.destination);
        const backupFiles = await findFiles(
            backupDirectory,
            [],
            tree.destination,
            true,
        );
        for (const backupFile of backupFiles) {
            const path = relative(backupDirectory, backupFile);
            if (!sourcePaths.has(path)) {
                await rm(backupFile, { force: true });
                removed.push(join(tree.destination, path));
            }
        }
    }

    if (removed.length === 0) {
        console.log("No stale agent backups to remove.");
        return;
    }
    console.log(`Removed stale agent backups: ${removed.join(", ")}`);
}

async function staleBackups(
    root: string,
    backupRoot: string,
    failures: string[],
): Promise<string[]> {
    const stale: string[] = [];
    for (const file of await backupFiles(root, backupRoot, failures)) {
        try {
            if (!await filesMatch(file.source, file.destination)) {
                stale.push(file.label);
            }
        } catch (error) {
            failures.push(`${file.label}: ${messageOf(error)}`);
        }
    }
    return stale;
}

async function backupFiles(
    root: string,
    backupRoot: string,
    failures: string[],
): Promise<BackupFile[]> {
    const files: BackupFile[] = [];
    for (const entry of BACKUP_FILES) {
        const source = join(root, entry.source);
        if (!await isFile(source)) {
            continue;
        }
        files.push({
            source,
            destination: join(backupRoot, entry.destination),
            label: entry.source,
        });
    }

    for (const tree of BACKUP_TREES) {
        const sourceDirectory = join(root, tree.source);
        for (const source of await findFiles(
            sourceDirectory,
            failures,
            tree.source,
        )) {
            const path = relative(sourceDirectory, source);
            files.push({
                source,
                destination: join(backupRoot, tree.destination, path),
                label: join(tree.source, path),
            });
        }
    }

    return files;
}

function sourceRoot(): string {
    const commonDir = gitCommonDirectory();
    if (commonDir !== undefined) {
        return dirname(resolve(SCRIPT_ROOT, commonDir));
    }
    return SCRIPT_ROOT;
}

function gitCommonDirectory(): string | undefined {
    const commands: readonly (readonly string[])[] = [
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ["rev-parse", "--git-common-dir"],
    ];
    for (const args of commands) {
        try {
            const output = execFileSync("git", args, {
                cwd: SCRIPT_ROOT,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (output !== "") {
                return output;
            }
        } catch {
            // An older git rejects --path-format; the next form still works.
        }
    }
    return undefined;
}

function configuredBackupRoot(): string {
    const backupRoot = process.env.VERA_AGENT_BACKUP_DIR;
    if (backupRoot === undefined || backupRoot.trim() === "") {
        throw new Error("VERA_AGENT_BACKUP_DIR must name the backup directory");
    }
    return resolve(backupRoot);
}

async function findFiles(
    directory: string,
    failures: string[],
    label: string,
    includeIgnored = false,
): Promise<string[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (!isMissing(error)) {
            failures.push(`${label}: ${messageOf(error)}`);
        }
        return [];
    }

    const files: string[] = [];
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (!includeIgnored && entry.name === IGNORED_NAME) {
            continue;
        }

        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await findFiles(
                path,
                failures,
                join(label, entry.name),
                includeIgnored,
            ));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }
    return files;
}

async function atomicCopy(source: string, destination: string): Promise<void> {
    const directory = dirname(destination);
    await mkdir(directory, { recursive: true });

    const temporary = join(
        directory,
        `.${basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}`,
    );
    try {
        await copyFile(source, temporary);
        await rename(temporary, destination);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

async function filesMatch(left: string, right: string): Promise<boolean> {
    if (!await isFile(right)) {
        return false;
    }

    const [leftContents, rightContents] = await Promise.all([
        readFile(left),
        readFile(right),
    ]);
    return leftContents.equals(rightContents);
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

function isMissing(error: unknown): boolean {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR";
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

await main();
