#!/usr/bin/env bun

// A root install does not cover clients/desktop, whose own package holds the
// Electron types the desktop source and its tests are typechecked against.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ELECTRON_PACKAGE = join("clients", "desktop", "node_modules", "electron", "package.json");

export interface WorktreeSetupStep {
    readonly description: string;
    readonly directory: string;
    readonly command: string;
    readonly args: readonly string[];
}

export function desktopDependenciesInstalled(
    root: string,
    exists: (path: string) => boolean = existsSync,
): boolean {
    return exists(join(root, ELECTRON_PACKAGE));
}

export function worktreeSetupSteps(
    root: string,
    exists: (path: string) => boolean = existsSync,
): WorktreeSetupStep[] {
    const steps: WorktreeSetupStep[] = [{
        description: "Installing the root dependencies.",
        directory: root,
        command: process.execPath,
        args: ["install", "--frozen-lockfile"],
    }];
    if (!desktopDependenciesInstalled(root, exists)) {
        steps.push({
            description: "Installing the desktop dependencies.",
            directory: join(root, "clients", "desktop"),
            command: process.execPath,
            args: ["install", "--frozen-lockfile"],
        });
    }
    return steps;
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, "..");
    console.log(`Worktree: ${root}`);
    for (const step of worktreeSetupSteps(root)) {
        console.log(step.description);
        const result = spawnSync(step.command, [...step.args], {
            cwd: step.directory,
            stdio: "inherit",
        });
        if (result.status !== 0) {
            const status = result.status === null ? "without a status" : `with ${result.status}`;
            console.error(`Setup stopped: the install in ${step.directory} exited ${status}.`);
            process.exit(result.status ?? 1);
        }
    }
    if (!desktopDependenciesInstalled(root)) {
        console.error(`The desktop dependencies are still missing at ${join(root, ELECTRON_PACKAGE)}.`);
        process.exit(1);
    }
    console.log("Dependencies are installed.");
}
