import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Database } from "bun:sqlite";

import { veraRuntimeDirectoryIn } from "../profile-paths.ts";
import { backupSqliteDatabase } from "../store/sqlite-backup.ts";

// Durable state that lives in the runtime folder and is carried into a fresh one.
const CARRIED_DATABASES = ["inbox.db", "schedules.db"] as const;
const CARRIED_DIRECTORIES = ["blocked"] as const;
const STASH_RECORD = "STASH.json";

export interface StashRecord {
    readonly stashed_at: string;
    readonly reason: string;
    readonly unknown_processes: readonly string[];
}

export interface StashResult {
    readonly path: string;
    // Durable files that could not be carried over; they stay in the stash.
    readonly notCarried: readonly string[];
}

export function runtimeStashesDirectory(home: string): string {
    return join(home, "runtime-stashes");
}

// Moves the runtime folder aside and starts an empty one with the inbox, schedules and session blocks copied in.
export function stashRuntime(home: string, record: Omit<StashRecord, "stashed_at">, now = new Date()): StashResult {
    const runtime = veraRuntimeDirectoryIn(home);
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const stashes = runtimeStashesDirectory(home);
    mkdirSync(stashes, { recursive: true, mode: 0o700 });
    const path = join(stashes, `stash-${stamp}`);
    if (existsSync(runtime)) renameSync(runtime, path);
    else mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, STASH_RECORD), `${JSON.stringify({ stashed_at: now.toISOString(), ...record }, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const notCarried: string[] = [];
    for (const name of CARRIED_DATABASES) {
        const source = join(path, name);
        if (!existsSync(source)) continue;
        try {
            const database = new Database(source, { readonly: true });
            try {
                backupSqliteDatabase(database, join(runtime, name));
            } finally {
                database.close();
            }
        } catch {
            notCarried.push(name);
        }
    }
    for (const name of CARRIED_DIRECTORIES) {
        const source = join(path, name);
        if (!existsSync(source)) continue;
        try {
            cpSync(source, join(runtime, name), { recursive: true });
        } catch {
            notCarried.push(name);
        }
    }
    return { path, notCarried };
}

// Puts a stash back as the runtime folder. The fresh folder is kept beside the stashes, never deleted.
export function restoreRuntimeStash(home: string, stashPath: string, now = new Date()): string {
    if (!existsSync(join(stashPath, STASH_RECORD))) {
        throw new Error(`${stashPath} is not a Vera runtime stash.`);
    }
    const runtime = veraRuntimeDirectoryIn(home);
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const discarded = join(runtimeStashesDirectory(home), `discarded-${stamp}`);
    if (existsSync(runtime)) renameSync(runtime, discarded);
    renameSync(stashPath, runtime);
    rmSync(join(runtime, STASH_RECORD), { force: true });
    return discarded;
}

export function readStashRecord(stashPath: string): StashRecord | undefined {
    try {
        return JSON.parse(readFileSync(join(stashPath, STASH_RECORD), "utf8")) as StashRecord;
    } catch {
        return undefined;
    }
}

// Files under the home that a process holds open, outside the runtime folder; sessions it could still be writing.
export function openFilesUnder(pid: number, home: string): readonly string[] {
    const runtime = veraRuntimeDirectoryIn(home) + sep;
    const under = (path: string): boolean => path.startsWith(home + sep) && !path.startsWith(runtime);
    // Linux, WSL included, lists open files in /proc without lsof, which many WSL distributions lack.
    if (process.platform === "linux") {
        try {
            const paths: string[] = [];
            for (const fd of readdirSync(`/proc/${pid}/fd`)) {
                try {
                    paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
                } catch {
                }
            }
            return paths.filter(under);
        } catch {
            return [];
        }
    }
    let output: string;
    try {
        output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-Fn"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3_000,
        });
    } catch {
        return [];
    }
    return output.split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1))
        .filter(under);
}
