import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desktopDependenciesInstalled, worktreeSetupSteps } from "../../scripts/worktree-setup.ts";

function checkout(options: { readonly desktopElectron?: boolean; readonly rootElectron?: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), "vera-worktree-setup-"));
    if (options.desktopElectron === true) {
        writeElectron(join(root, "clients", "desktop", "node_modules", "electron"));
    }
    if (options.rootElectron === true) {
        writeElectron(join(root, "node_modules", "electron"));
    }
    return root;
}

function writeElectron(directory: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), "{}\n");
}

test("setup installs the desktop package when its electron types are missing", () => {
    const root = checkout({});
    try {
        const steps = worktreeSetupSteps(root);
        expect(steps.map((step) => step.directory)).toEqual([root, join(root, "clients", "desktop")]);
        expect(steps.map((step) => step.args)).toEqual([["install", "--frozen-lockfile"], ["install", "--frozen-lockfile"]]);
        expect(desktopDependenciesInstalled(root)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("setup skips the desktop install when its electron types are present", () => {
    const root = checkout({ desktopElectron: true });
    try {
        expect(worktreeSetupSteps(root).map((step) => step.directory)).toEqual([root]);
        expect(desktopDependenciesInstalled(root)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a root electron install does not count as the desktop package's dependencies", () => {
    const root = checkout({ rootElectron: true });
    try {
        expect(desktopDependenciesInstalled(root)).toBe(false);
        expect(worktreeSetupSteps(root).map((step) => step.directory)).toEqual([root, join(root, "clients", "desktop")]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
