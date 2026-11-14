import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelRequestSnapshotPath } from "../../engine/events.ts";

export type MoveFilesOutcome =
    | { readonly status: "moved"; readonly names: readonly string[] }
    | { readonly status: "collision" | "failed" };

export interface TransferredEntry {
    readonly name: string;
    readonly from: string;
    readonly to: string;
}

class DestinationTaken extends Error {}

// Lists the top-level names of a folder; a folder that is already gone holds none.
export async function topLevelNames(folder: string): Promise<string[]> {
    try {
        return await readdir(folder);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export async function firstCollision(names: readonly string[], target: string): Promise<string | undefined> {
    for (const name of names) {
        if (await pathExists(join(target, name))) return name;
    }
    return undefined;
}

// rename keeps a folder in one step; across devices it cannot, so the copy is verified by the remove that follows.
async function transfer(from: string, to: string): Promise<void> {
    try {
        await rename(from, to);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    }
    try {
        await cp(from, to, {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
            preserveTimestamps: true,
        });
        await rm(from, { recursive: true, force: true });
    } catch (error) {
        await rm(to, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

// All or nothing: on any failure what moved goes back, and the source folder is removed only when empty.
export async function moveFolderContents(source: string, target: string): Promise<MoveFilesOutcome> {
    const done: TransferredEntry[] = [];
    try {
        const names = await topLevelNames(source);
        for (const name of names) {
            const to = join(target, name);
            // rename replaces a file silently, so the name is checked again at the moment of the move.
            if (await pathExists(to)) throw new DestinationTaken();
            await transfer(join(source, name), to);
            done.push({ name, from: join(source, name), to });
        }
        try {
            await rmdir(source);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return { status: "moved", names: done.map((entry) => entry.name) };
    } catch (error) {
        await restoreEntries(source, done);
        return { status: error instanceof DestinationTaken ? "collision" : "failed" };
    }
}

async function restoreEntries(source: string, done: readonly TransferredEntry[]): Promise<void> {
    await mkdir(source, { recursive: true, mode: 0o700 }).catch(() => {});
    await returnEntries(done);
}

// Puts back exactly the names that moved; the target may hold other files that are not ours.
export async function returnFolderContents(source: string, target: string, names: readonly string[]): Promise<void> {
    await restoreEntries(source, names.map((name) => ({ name, from: join(source, name), to: join(target, name) })));
}

// The event log and the model-request snapshot beside it follow the session to its new key.
// A destination that already exists is left alone; nothing is overwritten.
export async function moveEventLog(from: string, to: string): Promise<readonly TransferredEntry[]> {
    const done: TransferredEntry[] = [];
    try {
        for (const [source, destination] of [[from, to], [modelRequestSnapshotPath(from), modelRequestSnapshotPath(to)]] as const) {
            if (!await pathExists(source) || await pathExists(destination)) continue;
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await transfer(source, destination);
            done.push({ name: source, from: source, to: destination });
        }
        return done;
    } catch (error) {
        await returnEntries(done);
        throw error;
    }
}

export async function returnEntries(done: readonly TransferredEntry[]): Promise<void> {
    for (const entry of done.toReversed()) {
        await transfer(entry.to, entry.from).catch(() => {});
    }
}
