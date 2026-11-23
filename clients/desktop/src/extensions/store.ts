import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    DESKTOP_MENU_PLACES,
    type DesktopCommand,
    type DesktopFileFilter,
    type DesktopManifest,
    type DesktopMenuPlace,
    type DesktopTask,
} from "../../../ui/src/extensions/manifest.ts";
import type { DesktopExtensionEntry, DesktopExtensionMenus, DesktopMenuItem } from "../../../ui/src/protocol/extensions.ts";
import type { ImportedThemeSummary } from "../../../ui/src/theme/imported.ts";
import { MAX_EXTENSIONS, MAX_LISTED_THEMES } from "./limits.ts";
import { STAGING_PREFIX, extensionRoots, extensionsDirectory } from "./paths.ts";
import { isFolderName } from "../extension-files.ts";
import { desktopPluginFilesProblem } from "./plugin-files.ts";
import { MAX_PAGE_SCRIPT_BYTES, carriesCode, hasUnavailableContributions, readExtension, readManifest, readRegularFile, taskWorkerFile, type ExtensionTheme } from "./read-extension.ts";
import type { ExtensionStateStore } from "./state.ts";

export type CommitResult =
    | { readonly ok: true; readonly id: string; readonly replaced: string | undefined; readonly replacedId?: string }
    | { readonly ok: false; readonly reason: string };

export type RemoveResult = "removed" | "included" | "missing" | "failed" | { readonly plugin: string };

// Where and how a command's task runs.
export interface CommandTarget {
    readonly taskFile: string;
    // The process name the system shows while the task runs.
    readonly taskTitle: string;
    readonly file?: DesktopFileFilter;
}

interface ScanResult {
    readonly entries: Found[];
    readonly diagnostics: { readonly directory: string; readonly problem: string }[];
    readonly listingProblem?: string;
    readonly truncated?: boolean;
}

interface AllScanResult extends ScanResult {
    readonly pluginOwners: ReadonlyMap<string, string>;
}

interface Found {
    readonly id: string;
    readonly folder: string;
    readonly included: boolean;
    readonly plugin?: string;
    readonly version: string;
    readonly themes: readonly string[];
    readonly hasMain: boolean;
    readonly main?: string;
    readonly hasCommands: boolean;
    readonly hasUnavailableContributions: boolean;
    readonly keybindings: DesktopManifest["keybindings"];
    readonly tasks: readonly DesktopTask[];
    readonly commands: readonly DesktopCommand[];
    readonly menus: DesktopManifest["menus"];
    readonly filePreviews?: readonly string[];
}

// The commands the window can run: those that name a task of an extension included with Vera, the only ones that run.
function runnableCommands(entry: Found): readonly DesktopCommand[] {
    return entry.included ? entry.commands.filter((command) => command.task !== undefined || command.page !== undefined) : [];
}

function menuItems(entry: Found, place: DesktopMenuPlace): readonly DesktopMenuItem[] {
    const runnable = runnableCommands(entry);
    const items: DesktopMenuItem[] = [];
    for (const listed of entry.menus[place]) {
        const command = runnable.find((candidate) => candidate.command === listed.command);
        if (command === undefined) continue;
        items.push({
            command: command.command,
            title: listed.title ?? command.title,
            ...(command.page === undefined ? {} : { page: true as const }),
            ...(listed.description === undefined ? {} : { description: listed.description }),
            ...(listed.button === undefined ? {} : { button: listed.button }),
            ...(listed.icon === undefined ? {} : { icon: listed.icon }),
        });
    }
    return items;
}

function menusOf(entry: Found): DesktopExtensionMenus {
    const menus: Record<DesktopMenuPlace, readonly DesktopMenuItem[]> = { appearance: [], theme: [], browser: [] };
    for (const place of DESKTOP_MENU_PLACES) menus[place] = menuItems(entry, place);
    return menus;
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

function foundExtension(manifest: DesktopManifest, folder: string, included: boolean, plugin?: string): Found {
    return {
        id: manifest.id,
        folder,
        included,
        ...(plugin === undefined ? {} : { plugin }),
        version: manifest.version,
        themes: manifest.themes.map((theme) => theme.label),
        hasMain: carriesCode(manifest),
        ...(manifest.main === undefined ? {} : { main: manifest.main }),
        hasCommands: manifest.commands.length > 0,
        hasUnavailableContributions: !included && hasUnavailableContributions(manifest),
        keybindings: manifest.keybindings,
        tasks: manifest.tasks,
        commands: manifest.commands,
        menus: manifest.menus,
        ...(manifest.filePreviews === undefined ? {} : { filePreviews: manifest.filePreviews }),
    };
}

export class ExtensionStore {
    // Staging folders an install or import is still using, which `clearStaging` leaves alone.
    private readonly active = new Set<string>();
    private readonly root: string;

    constructor(
        private readonly home: string,
        private readonly state: ExtensionStateStore,
        private readonly included: string | undefined = undefined,
    ) {
        this.root = extensionsDirectory(home);
    }

    private scan(directory: string | undefined, included: boolean, collectDiagnostics = false): ScanResult {
        if (directory === undefined) return { entries: [], diagnostics: [] };
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch (error) {
            const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
            return {
                entries: [],
                diagnostics: [],
                ...(!missing ? { listingProblem: "The extensions folder could not be read." } : {}),
            };
        }
        const found: Found[] = [];
        const diagnostics: { directory: string; problem: string }[] = [];
        const fail = (name: string, problem: string): void => {
            if (collectDiagnostics && diagnostics.length < MAX_EXTENSIONS) diagnostics.push({ directory: name, problem });
        };
        names.sort();
        let truncated = false;
        for (let index = 0; index < names.length; index += 1) {
            const name = names[index]!;
            if (name.startsWith(".")) continue;
            const folder = join(directory, name);
            try {
                if (!lstatSync(folder).isDirectory()) continue;
            } catch {
                continue;
            }
            if (!isFolderName(name)) {
                fail(name, "The folder name is not a valid extension id.");
                continue;
            }
            const read = readManifest(folder);
            if (!read.ok) {
                fail(name, read.reason === "The extension has no vera.desktop.json." ? "No vera.desktop.json in this folder." : read.reason);
                continue;
            }
            if (read.manifest.id !== name) {
                fail(name, `The folder name must match the extension id "${read.manifest.id}".`);
                continue;
            }
            found.push(foundExtension(read.manifest, folder, included));
            if (found.length >= MAX_EXTENSIONS) {
                truncated = index < names.length - 1;
                break;
            }
        }
        return { entries: found, diagnostics, truncated };
    }

    private scanAll(collectDiagnostics = false): AllScanResult {
        const roots = extensionRoots(this.home, this.included);
        const found: Found[] = [];
        const taken = new Map<string, Found>();
        const pluginOwners = new Map<string, string>();
        const diagnostics: { directory: string; problem: string }[] = [];
        let listingProblem: string | undefined;
        let truncated = false;
        const fail = (directory: string, problem: string): void => {
            if (collectDiagnostics && diagnostics.length < MAX_EXTENSIONS) diagnostics.push({ directory, problem });
        };
        for (const claim of roots.claims) {
            if (!pluginOwners.has(claim.id)) pluginOwners.set(claim.id, claim.plugin);
        }
        for (const warning of roots.warnings) fail("plugins", warning);
        for (const root of roots.roots) {
            if (root.kind === "plugin") {
                const problem = desktopPluginFilesProblem(root.directory);
                if (problem !== undefined) {
                    fail(root.directory, `Plugin "${root.plugin}": ${problem}`);
                    continue;
                }
                const read = readManifest(root.directory);
                if (!read.ok) {
                    fail(root.directory, `Plugin "${root.plugin}": ${read.reason}`);
                    continue;
                }
                if (read.manifest.id !== root.id) {
                    const recorded = root.id === null ? "none" : `"${root.id}"`;
                    fail(root.directory, `Plugin "${root.plugin}" records desktop extension id ${recorded}, but vera.desktop.json names "${read.manifest.id}". Install the plugin again from its source.`);
                    continue;
                }
                const entry = foundExtension(read.manifest, root.directory, false, root.plugin);
                const previous = taken.get(entry.id);
                const owner = pluginOwners.get(entry.id);
                if (previous !== undefined || (owner !== undefined && owner !== root.plugin)) {
                    const source = previous?.included ? "an included extension" : `plugin "${previous?.plugin ?? owner}"`;
                    fail(root.directory, `Desktop extension "${entry.id}" from plugin "${root.plugin}" is skipped because ${source} has the same id.`);
                    continue;
                }
                pluginOwners.set(entry.id, root.plugin);
                found.push(entry);
                taken.set(entry.id, entry);
                continue;
            }
            const scanned = this.scan(root.directory, root.kind === "included", collectDiagnostics && root.kind === "installed");
            if (root.kind === "installed") {
                listingProblem = scanned.listingProblem;
                truncated ||= scanned.truncated ?? false;
                for (const diagnostic of scanned.diagnostics) fail(diagnostic.directory, diagnostic.problem);
            }
            for (const entry of scanned.entries) {
                const previous = taken.get(entry.id);
                const owner = root.kind === "installed" ? pluginOwners.get(entry.id) : undefined;
                if (previous !== undefined || owner !== undefined) {
                    if (owner !== undefined && !previous?.included) {
                        fail(entry.id, `Desktop extension "${entry.id}" is skipped because plugin "${owner}" has the same id.`);
                    }
                    continue;
                }
                found.push(entry);
                taken.set(entry.id, entry);
            }
        }
        if (found.length > MAX_EXTENSIONS) truncated = true;
        return {
            entries: found.slice(0, MAX_EXTENSIONS).sort((a, b) => a.id.localeCompare(b.id)),
            diagnostics,
            pluginOwners,
            ...(listingProblem === undefined ? {} : { listingProblem }),
            truncated,
        };
    }

    private all(): readonly Found[] {
        return this.scanAll().entries;
    }

    listing(): { readonly entries: readonly DesktopExtensionEntry[]; readonly diagnostics: readonly { readonly directory: string; readonly problem: string }[]; readonly listingProblem?: string; readonly truncated?: boolean } {
        const scanned = this.scanAll(true);
        return {
            entries: this.present(scanned.entries),
            diagnostics: scanned.diagnostics,
            ...(scanned.listingProblem === undefined ? {} : { listingProblem: scanned.listingProblem }),
            ...(scanned.truncated === undefined ? {} : { truncated: scanned.truncated }),
        };
    }

    // An extension included with Vera is always on, whatever the state file lists.
    private off(entry: Found, disabled: ReadonlySet<string>): boolean {
        return !entry.included && entry.plugin === undefined && disabled.has(entry.id);
    }

    entries(): readonly DesktopExtensionEntry[] {
        return this.listing().entries;
    }

    private present(entries: readonly Found[]): readonly DesktopExtensionEntry[] {
        const disabled = this.state.disabled();
        return entries.map((entry) => {
            const worker = this.worker(entry, disabled);
            return {
                id: entry.id,
                version: entry.version,
                themes: entry.themes,
                hasMain: entry.hasMain,
                hasCommands: entry.hasCommands,
                hasUnavailableContributions: entry.hasUnavailableContributions,
                ...(worker === undefined ? {} : { worker }),
                commands: runnableCommands(entry).map((command) => ({
                    id: command.command,
                    title: command.title,
                    ...(command.category === undefined ? {} : { category: command.category }),
                })),
                menus: menusOf(entry),
                ...(entry.included && entry.filePreviews !== undefined ? { filePreviews: entry.filePreviews } : {}),
                included: entry.included,
                enabled: !this.off(entry, disabled),
            };
        });
    }

    private worker(entry: Found, disabled: ReadonlySet<string>): DesktopExtensionEntry["worker"] {
        if (entry.included || this.off(entry, disabled) || entry.main === undefined) return undefined;
        const commands = entry.commands.filter((command) => command.task === undefined && command.page === undefined);
        return {
            main: entry.main,
            commands: commands.map((command) => ({
                command: command.command,
                title: command.title,
                ...(command.category === undefined ? {} : { category: command.category }),
                ...(command.when === undefined ? {} : { when: command.when.source }),
            })),
            keybindings: entry.keybindings.filter((binding) => commands.some((command) => command.command === binding.command)).map((binding) => ({
                command: binding.command,
                key: binding.key,
                ...(binding.mac === undefined ? {} : { mac: binding.mac }),
                ...(binding.when === undefined ? {} : { when: binding.when.source }),
            })),
        };
    }

    // The entries of one menu place, from every enabled extension.
    menu(place: DesktopMenuPlace): readonly DesktopMenuItem[] {
        const disabled = this.state.disabled();
        return this.all().filter((entry) => !this.off(entry, disabled)).flatMap((entry) => menuItems(entry, place));
    }

    installedVersion(id: string): string | undefined {
        return this.scan(this.root, false).entries.find((entry) => entry.id === id)?.version;
    }

    installedMain(id: string): { readonly folder: string; readonly main: string } | undefined {
        const disabled = this.state.disabled();
        const entry = this.all().find((candidate) => candidate.id === id && !candidate.included && !this.off(candidate, disabled));
        return entry?.main === undefined ? undefined : { folder: entry.folder, main: entry.main };
    }

    // The themes of the enabled extensions, one extension's file at a time with its token rules dropped.
    themes(): readonly ImportedThemeSummary[] {
        const disabled = this.state.disabled();
        const themes = new Map<string, ImportedThemeSummary>();
        for (const entry of this.all()) {
            if (this.off(entry, disabled)) continue;
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

    // The task behind a command of an extension included with Vera. An installed extension never runs a command.
    // Undefined means it must not run.
    commandTarget(command: string): CommandTarget | undefined {
        const entry = this.scan(this.included, true).entries.find((candidate) => candidate.commands.some((declared) => declared.command === command));
        const declared = entry?.commands.find((candidate) => candidate.command === command);
        const task = entry?.tasks.find((candidate) => candidate.id === declared?.task);
        if (entry === undefined || declared === undefined || task === undefined) return undefined;
        const taskFile = taskWorkerFile(entry.folder, task.main);
        if (taskFile === undefined) return undefined;
        return { taskFile, taskTitle: task.title, ...(declared.file === undefined ? {} : { file: declared.file }) };
    }

    pageScript(command: string): string | undefined {
        const entry = this.scan(this.included, true).entries.find((candidate) => candidate.commands.some((declared) => declared.command === command));
        const declared = entry?.commands.find((candidate) => candidate.command === command);
        if (entry === undefined || declared?.page === undefined) return undefined;
        const file = taskWorkerFile(entry.folder, declared.page);
        return file === undefined ? undefined : readRegularFile(file, MAX_PAGE_SCRIPT_BYTES);
    }

    // False when the id is not an installed extension, or the state file could not be written. An included
    // extension is always on, so it cannot be turned off.
    setEnabled(id: string, enabled: boolean): boolean {
        return this.all().some((entry) => entry.id === id && !entry.included && entry.plugin === undefined)
            && this.state.setEnabled(id, enabled);
    }

    pluginOwner(id: string): string | undefined {
        const scanned = this.scanAll();
        if (scanned.entries.some((entry) => entry.id === id && entry.included)) return undefined;
        return scanned.pluginOwners.get(id);
    }

    remove(id: string): RemoveResult {
        if (this.scan(this.included, true).entries.some((entry) => entry.id === id)) return "included";
        const plugin = this.pluginOwner(id);
        if (plugin !== undefined) return { plugin };
        const entry = this.scan(this.root, false).entries.find((candidate) => candidate.id === id);
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
        if (this.scan(this.included, true).entries.some((entry) => entry.id === id)) {
            return { ok: false, reason: `"${id}" is included with Vera and cannot be replaced.` };
        }
        const target = join(this.root, id);
        const existing = existsSync(target);
        if (!existing && this.all().length >= MAX_EXTENSIONS) {
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
        return { ok: true, id, replaced, ...(existing ? { replacedId: id } : {}) };
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
