import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { DesktopTask } from "../../../ui/src/extensions/manifest.ts";
import type { DesktopExtensionEntry } from "../../../ui/src/protocol/extensions.ts";
import type { ImportedThemeSummary } from "../../../ui/src/theme/imported.ts";
import { MAX_EXTENSIONS, MAX_LISTED_THEMES } from "./limits.ts";
import { STAGING_PREFIX } from "./paths.ts";
import { carriesCode, readExtension, readManifest, taskWorkerFile, type ExtensionTheme } from "./read-extension.ts";
import type { ExtensionStateStore } from "./state.ts";

export type CommitResult =
    | { readonly ok: true; readonly id: string; readonly replaced: string | undefined }
    | { readonly ok: false; readonly reason: string };

export type RemoveResult = "removed" | "included" | "missing" | "failed";

interface Found {
    readonly id: string;
    readonly folder: string;
    readonly included: boolean;
    readonly version: string;
    readonly themes: readonly string[];
    readonly hasMain: boolean;
    readonly hasCommands: boolean;
    readonly tasks: readonly DesktopTask[];
}

// The key the page knows a theme by. A theme imported from VS Code, or saved in the old themes folder, lives in an
// extension named `imported.<slug>` and keeps the slug as its key, so a choice made before extensions still resolves.
export function themeKey(extensionId: string, slug: string): string {
    return extensionId === `imported.${slug}` ? slug : `${extensionId}.${slug}`;
}

// A theme as the picker lists it: keyed by its extension and named by the manifest's label.
export function pickerTheme(extensionId: string, theme: ExtensionTheme): ImportedThemeSummary {
    return { ...theme.summary, slug: themeKey(extensionId, theme.summary.slug), name: theme.label };
}

// Installed extensions are folders under `root`; included ones are folders in the app. The host never reads them.
export class ExtensionStore {
    // Staging folders an install or import is still using, which `clearStaging` leaves alone.
    private readonly active = new Set<string>();

    constructor(
        private readonly root: string,
        private readonly state: ExtensionStateStore,
        private readonly included: string | undefined = undefined,
    ) {}

    private scan(directory: string | undefined, included: boolean): Found[] {
        if (directory === undefined) return [];
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch {
            return [];
        }
        const found: Found[] = [];
        for (const name of names.sort()) {
            if (name.startsWith(".")) continue;
            const folder = join(directory, name);
            try {
                if (!lstatSync(folder).isDirectory()) continue;
            } catch {
                continue;
            }
            const read = readManifest(folder);
            if (!read.ok || read.manifest.id !== name) continue;
            const { manifest } = read;
            found.push({
                id: name,
                folder,
                included,
                version: manifest.version,
                themes: manifest.themes.map((theme) => theme.label),
                hasMain: carriesCode(manifest),
                hasCommands: manifest.commands.length > 0,
                tasks: manifest.tasks,
            });
            if (found.length >= MAX_EXTENSIONS) break;
        }
        return found;
    }

    private all(): Found[] {
        const included = this.scan(this.included, true);
        const taken = new Set(included.map((entry) => entry.id));
        return [...included, ...this.scan(this.root, false).filter((entry) => !taken.has(entry.id))]
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    entries(): readonly DesktopExtensionEntry[] {
        const disabled = this.state.disabled();
        return this.all().map((entry) => ({
            id: entry.id,
            version: entry.version,
            themes: entry.themes,
            hasMain: entry.hasMain,
            hasCommands: entry.hasCommands,
            included: entry.included,
            enabled: !disabled.has(entry.id),
        }));
    }

    installedVersion(id: string): string | undefined {
        return this.scan(this.root, false).find((entry) => entry.id === id)?.version;
    }

    // The themes of the enabled extensions, one extension's file at a time with its token rules dropped.
    themes(): readonly ImportedThemeSummary[] {
        const disabled = this.state.disabled();
        const themes = new Map<string, ImportedThemeSummary>();
        for (const entry of this.all()) {
            if (disabled.has(entry.id)) continue;
            const read = readExtension(entry.folder);
            if (!read.ok) continue;
            for (const theme of read.themes) {
                const listed = pickerTheme(entry.id, theme);
                if (!themes.has(listed.slug)) themes.set(listed.slug, listed);
            }
            if (themes.size >= MAX_LISTED_THEMES) break;
        }
        return [...themes.values()].slice(0, MAX_LISTED_THEMES).sort((a, b) => a.name.localeCompare(b.name));
    }

    // The worker file of a task, only for an extension included with Vera that is turned on. An installed
    // extension never runs a task, and neither does one that is turned off. Undefined means it must not run.
    taskFile(extensionId: string, taskId: string): string | undefined {
        if (this.state.disabled().has(extensionId)) return undefined;
        const entry = this.scan(this.included, true).find((candidate) => candidate.id === extensionId);
        const task = entry?.tasks.find((candidate) => candidate.id === taskId);
        return entry === undefined || task === undefined ? undefined : taskWorkerFile(entry.folder, task.main);
    }

    // False when the id is not an extension, or the state file could not be written.
    setEnabled(id: string, enabled: boolean): boolean {
        return this.all().some((entry) => entry.id === id) && this.state.setEnabled(id, enabled);
    }

    remove(id: string): RemoveResult {
        if (this.scan(this.included, true).some((entry) => entry.id === id)) return "included";
        const entry = this.scan(this.root, false).find((candidate) => candidate.id === id);
        if (entry === undefined) return "missing";
        try {
            rmSync(entry.folder, { recursive: true, force: true });
        } catch {
            return "failed";
        }
        if (existsSync(entry.folder)) return "failed";
        this.state.setEnabled(id, true);
        return "removed";
    }

    // A new empty folder where a package is unpacked or an extension is built before it is installed.
    newStaging(): string {
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const staging = mkdtempSync(join(this.root, STAGING_PREFIX));
        this.active.add(staging);
        return staging;
    }

    // Deletes a staging folder that will not be installed.
    discard(staging: string): void {
        this.active.delete(staging);
        rmSync(staging, { recursive: true, force: true });
    }

    // Removes what an install that never finished left behind, except folders still in use.
    clearStaging(): void {
        let names: string[];
        try {
            names = readdirSync(this.root);
        } catch {
            return;
        }
        for (const name of names) {
            const folder = join(this.root, name);
            if (name.startsWith(STAGING_PREFIX) && !this.active.has(folder)) rmSync(folder, { recursive: true, force: true });
        }
    }

    // The only way an extension enters the installed folder: the staged folder is checked, then moved over any
    // extension of the same id, and checked again in its place. A failure leaves the old version installed.
    commit(staging: string): CommitResult {
        const read = readExtension(staging);
        if (!read.ok) return read;
        const id = read.manifest.id;
        if (this.scan(this.included, true).some((entry) => entry.id === id)) {
            return { ok: false, reason: `"${id}" is included with Vera and cannot be replaced.` };
        }
        const target = join(this.root, id);
        const existing = existsSync(target);
        if (!existing && this.scan(this.root, false).length >= MAX_EXTENSIONS) {
            return { ok: false, reason: `Vera keeps at most ${MAX_EXTENSIONS} desktop extensions. Remove one first.` };
        }
        const replaced = existing ? this.installedVersion(id) : undefined;
        const backup = join(this.root, `${STAGING_PREFIX}old-${id}`);
        const failure = { ok: false, reason: `Vera could not install "${id}".` } as const;
        try {
            if (existing) {
                rmSync(backup, { recursive: true, force: true });
                renameSync(target, backup);
            }
            renameSync(staging, target);
        } catch {
            this.restore(target, backup, existing);
            return failure;
        }
        if (!readExtension(target).ok) {
            rmSync(target, { recursive: true, force: true });
            this.restore(target, backup, existing);
            return failure;
        }
        rmSync(backup, { recursive: true, force: true });
        this.active.delete(staging);
        return { ok: true, id, replaced };
    }

    private restore(target: string, backup: string, existed: boolean): void {
        if (!existed || !existsSync(backup)) return;
        try {
            rmSync(target, { recursive: true, force: true });
            renameSync(backup, target);
        } catch {
            // The old version stays in the backup folder until the next install clears it.
        }
    }
}
