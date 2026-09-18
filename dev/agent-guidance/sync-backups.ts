import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

interface BackupFile {
    readonly source: string;
    readonly destination: string;
    readonly label: string;
}

async function main(): Promise<void> {
    const checkOnly = process.argv.includes("--check");

    const staleBefore = await staleBackups();
    if (checkOnly) {
        if (staleBefore.length === 0) {
            console.log("Agent backups are current.");
            return;
        }

        console.error(`Agent backups are stale: ${staleBefore.join(", ")}`);
        process.exitCode = 1;
        return;
    }

    if (staleBefore.length === 0) {
        console.log("Agent backups are current.");
        return;
    }

    try {
        await syncBackups();
        const staleAfter = await staleBackups();
        if (staleAfter.length > 0) {
            throw new Error(`Backup sync left stale files: ${staleAfter.join(", ")}`);
        }

        console.log(`Updated agent backups: ${staleBefore.join(", ")}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    }
}

async function staleBackups(): Promise<string[]> {
    const stale: string[] = [];
    for (const file of await backupFiles()) {
        if (!await filesMatch(file.source, file.destination)) {
            stale.push(file.label);
        }
    }
    return stale;
}

async function syncBackups(): Promise<void> {
    for (const file of await backupFiles()) {
        if (await filesMatch(file.source, file.destination)) {
            continue;
        }

        await mkdir(dirname(file.destination), { recursive: true });
        await copyFile(file.source, file.destination);
    }
}

async function backupFiles(): Promise<BackupFile[]> {
    const files: BackupFile[] = [];
    const backupRoot = configuredBackupRoot();
    const localGuidance = join(PROJECT_ROOT, "AGENTS.local.md");
    if (await isFile(localGuidance)) {
        files.push({
            source: localGuidance,
            destination: join(backupRoot, "AGENTS.local.md"),
            label: "AGENTS.local.md",
        });
    }

    const notesRoot = join(PROJECT_ROOT, ".agent-notes");
    for (const source of await findFiles(notesRoot)) {
        const notePath = relative(notesRoot, source);
        files.push({
            source,
            destination: join(backupRoot, "agent-notes", notePath),
            label: join(".agent-notes", notePath),
        });
    }

    const routesFile = join(PROJECT_ROOT, ".vera", "context-routes.yaml");
    if (await isFile(routesFile)) {
        files.push({
            source: routesFile,
            destination: join(backupRoot, ".vera", "context-routes.yaml"),
            label: join(".vera", "context-routes.yaml"),
        });
    }

    const routesRoot = join(PROJECT_ROOT, ".vera", "context-routes");
    for (const source of await findFiles(routesRoot)) {
        const routePath = relative(routesRoot, source);
        files.push({
            source,
            destination: join(backupRoot, ".vera", "context-routes", routePath),
            label: join(".vera", "context-routes", routePath),
        });
    }

    return files;
}

function configuredBackupRoot(): string {
    const backupRoot = process.env.VERA_AGENT_BACKUP_DIR;
    if (backupRoot === undefined || backupRoot.trim() === "") {
        throw new Error("VERA_AGENT_BACKUP_DIR must name the backup directory");
    }
    return resolve(backupRoot);
}

async function findFiles(directory: string): Promise<string[]> {
    if (!await isDirectory(directory)) {
        return [];
    }

    const files: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await findFiles(path));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }
    return files;
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

await main();
