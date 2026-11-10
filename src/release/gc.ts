import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
    defaultInstallPrefix,
    currentSymlinkPath,
    releaseDirectory,
    releasesDirectory,
    rollbackSymlinkPath,
} from "./layout.ts";
import {
    referenceReasons,
} from "./references.ts";

export class ReleaseInUseError extends Error {
    constructor(
        readonly buildId: string,
        readonly reasons: readonly string[],
    ) {
        const why = reasons.length === 0 ? "referenced" : reasons.join(", ");
        const damaged = reasons.includes("host-lock-damaged")
            ? " The host lockfile is damaged, so Vera cannot tell which release a running host uses."
            : "";
        const unknown = reasons.includes("host-build-unknown")
            ? " The host lockfile names no build, so Vera cannot tell which release the running host uses."
            : "";
        super(`Release ${buildId} is still ${why} and cannot be removed.${damaged}${unknown}`);
        this.name = "ReleaseInUseError";
    }
}

export function removeRelease(
    buildId: string,
    prefix = defaultInstallPrefix(),
): void {
    // One call: each reference check on a damaged lockfile runs ps.
    const reasons = referenceReasons(buildId, prefix);
    if (reasons.length > 0) {
        throw new ReleaseInUseError(buildId, reasons);
    }
    const path = releaseDirectory(buildId, prefix);
    if (!existsSync(path)) {
        return;
    }
    rmSync(path, { recursive: true, force: false });
}

export interface GcOptions {
    readonly onHeld?: (reason: string) => void;
    readonly listProcessExecutables?: () => readonly string[];
}

function processExecutables(): readonly string[] {
    if (process.platform === "linux") {
        readlinkSync("/proc/self/exe");
        return readdirSync("/proc", { withFileTypes: true })
            .filter((entry) => /^\d+$/.test(entry.name))
            .flatMap((entry) => {
                try { return [readlinkSync(join("/proc", entry.name, "exe"))]; } catch { return []; }
            });
    }
    if (process.platform === "darwin") {
        const result = spawnSync("lsof", ["-nP", "-w", "-d", "txt", "-Fn"], { encoding: "utf8" });
        if (result.error || result.status !== 0) {
            throw new Error(`Cannot inspect running processes: ${result.error?.message ?? `lsof exited ${result.status}`}`);
        }
        return result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
    }
    throw new Error("Cannot inspect running processes: unsupported platform");
}

function inUse(paths: readonly string[], roots: readonly string[], name: string): boolean {
    return paths.some((path) => roots.some((root) => {
        const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";
        return relative.startsWith(`${name}/`) || (
            relative.startsWith(`.gc-${name}-`) && relative.includes("/")
        );
    }));
}

function buildTime(path: string): number {
    try {
        const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as { built_at?: unknown };
        if (typeof manifest.built_at === "string") {
            const time = Date.parse(manifest.built_at);
            if (Number.isFinite(time)) return time;
        }
    } catch {
    }
    return statSync(path).mtimeMs;
}

function restoreRelease(temporary: string, path: string): void {
    if (existsSync(path)) throw new Error(`${path} already exists`);
    renameSync(temporary, path);
}

function linkTarget(path: string, root: string): string | undefined {
    try {
        const target = resolve(dirname(path), readlinkSync(path));
        return dirname(target) === root ? basename(target) : undefined;
    } catch {
        return undefined;
    }
}

export function gcReleases(
    prefix = defaultInstallPrefix(),
    options: GcOptions = {},
): readonly string[] {
    const root = resolve(releasesDirectory(prefix));
    if (!existsSync(root)) {
        return [];
    }
    const entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, time: buildTime(join(root, entry.name)) }))
        .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
    const kept = new Set(entries.slice(0, 3).map((entry) => entry.name));
    kept.add(linkTarget(currentSymlinkPath(prefix), root) ?? "");
    kept.add(linkTarget(rollbackSymlinkPath(prefix), root) ?? "");
    const removed: string[] = [];
    let processes: readonly string[];
    let roots: readonly string[];
    const listProcesses = options.listProcessExecutables ?? processExecutables;
    try {
        roots = [root, realpathSync(root)];
        processes = listProcesses();
    } catch (error) {
        options.onHeld?.(String(error));
        return removed;
    }
    for (const { name } of entries) {
        const path = join(root, name);
        const temporary = join(root, `.gc-${name}-${process.pid}`);
        if (kept.has(name) || inUse(processes, roots, name)) continue;
        try {
            if (existsSync(temporary)) throw new Error(`${temporary} already exists`);
            renameSync(path, temporary);
        } catch (error) {
            options.onHeld?.(`Could not remove ${path}: ${String(error)}`);
            continue;
        }
        try {
            processes = listProcesses();
        } catch (error) {
            try { restoreRelease(temporary, path); } catch (restore) {
                options.onHeld?.(`Could not restore ${path}: ${String(restore)}`);
            }
            options.onHeld?.(String(error));
            break;
        }
        if (inUse(processes, roots, name)) {
            try { restoreRelease(temporary, path); } catch (error) {
                options.onHeld?.(`Could not restore ${path}: ${String(error)}`);
            }
            continue;
        }
        try {
            rmSync(temporary, { recursive: true, force: false });
            removed.push(name);
        } catch (error) {
            options.onHeld?.(`Could not remove ${temporary}: ${String(error)}`);
        }
    }
    return removed;
}
