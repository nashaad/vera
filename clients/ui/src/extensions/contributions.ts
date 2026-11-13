import type { CommandRegistry } from "../commands/registry.ts";
import { findKeybindingConflicts, type ContributedKeybinding, type KeybindingConflict } from "./keybindings.ts";
import type { DesktopManifest } from "./manifest.ts";
import { evaluateWhen, type WhenContext, type WhenExpression } from "./when.ts";

export interface ContributedCommand {
    readonly extensionId: string;
    readonly id: string;
    // The palette title, with the category in front when the manifest gave one.
    readonly title: string;
    readonly when?: WhenExpression;
}

export interface ExtensionSummary {
    readonly id: string;
    readonly version: string;
    readonly main?: string;
}

export interface ExtensionFailure {
    readonly extensionId: string;
    readonly reason: string;
}

export type AddResult = { readonly ok: true } | ({ readonly ok: false } & ExtensionFailure);

export interface ContributionSnapshot {
    readonly extensions: readonly ExtensionSummary[];
    readonly commands: readonly ContributedCommand[];
    readonly keybindings: readonly ContributedKeybinding[];
    readonly conflicts: readonly KeybindingConflict[];
    readonly failures: readonly ExtensionFailure[];
}

export interface DesktopExtensionOptions {
    // Starts the extension's module if needed and runs the command. It reports its own failures.
    readonly activateAndRun: (extensionId: string, commandId: string, args?: unknown) => void;
}

interface LoadedExtension {
    readonly summary: ExtensionSummary;
    readonly commands: readonly ContributedCommand[];
    readonly keybindings: readonly ContributedKeybinding[];
    readonly disposers: readonly (() => void)[];
}

// Contributed commands go into the shared CommandRegistry, so the palette, menus and shortcuts run them
// like core commands. Register core commands first: a core id taken by an extension fails the extension.
export class DesktopExtensionRegistry {
    private readonly registry: CommandRegistry;
    private readonly options: DesktopExtensionOptions;
    private readonly extensions = new Map<string, LoadedExtension>();
    private readonly failures = new Map<string, string>();
    private readonly owners = new Map<string, string>();
    private readonly whens = new Map<string, WhenExpression>();
    private readonly listeners = new Set<() => void>();
    private cached: ContributionSnapshot | undefined;

    constructor(registry: CommandRegistry, options: DesktopExtensionOptions) {
        this.registry = registry;
        this.options = options;
    }

    // Replaces anything the extension contributed before. A failure leaves the extension with nothing drawn.
    add(manifest: DesktopManifest): AddResult {
        const extensionId = manifest.id;
        this.drop(extensionId);
        for (const { command } of manifest.commands) {
            const owner = this.owners.get(command);
            if (owner !== undefined) return this.fail(extensionId, `Command "${command}" is already contributed by extension ${owner}.`);
            if (this.registry.has(command)) return this.fail(extensionId, `Command "${command}" is a core command.`);
        }

        const disposers: (() => void)[] = [];
        const commands = manifest.commands.map((contribution): ContributedCommand => {
            const id = contribution.command;
            const title = contribution.category === undefined ? contribution.title : `${contribution.category}: ${contribution.title}`;
            const when = contribution.when?.expression;
            disposers.push(this.registry.register({
                id,
                title,
                run: (args) => this.options.activateAndRun(extensionId, id, args),
            }));
            this.owners.set(id, extensionId);
            if (when !== undefined) this.whens.set(id, when);
            return { extensionId, id, title, ...(when === undefined ? {} : { when }) };
        });
        const keybindings = manifest.keybindings.map((binding): ContributedKeybinding => ({
            extensionId,
            command: binding.command,
            key: binding.key,
            ...(binding.mac === undefined ? {} : { mac: binding.mac }),
            ...(binding.when === undefined ? {} : { when: binding.when.expression }),
        }));

        this.failures.delete(extensionId);
        this.extensions.set(extensionId, {
            summary: { id: extensionId, version: manifest.version, ...(manifest.main === undefined ? {} : { main: manifest.main }) },
            commands,
            keybindings,
            disposers,
        });
        this.changed();
        return { ok: true };
    }

    // Draws nothing for the extension and lists why, for a manifest that did not load.
    fail(extensionId: string, reason: string): AddResult {
        this.drop(extensionId);
        this.failures.set(extensionId, reason);
        this.changed();
        return { ok: false, extensionId, reason };
    }

    remove(extensionId: string): void {
        const dropped = this.drop(extensionId);
        if (this.failures.delete(extensionId) || dropped) this.changed();
    }

    // False when a contributed command's when-clause does not hold. Any other command is always visible.
    isVisible(commandId: string, context: WhenContext): boolean {
        const when = this.whens.get(commandId);
        return when === undefined || evaluateWhen(when, context);
    }

    // The same object until an extension is added, failed or removed.
    snapshot(): ContributionSnapshot {
        if (this.cached === undefined) {
            const loaded = [...this.extensions.values()];
            const keybindings = loaded.flatMap((entry) => entry.keybindings);
            this.cached = {
                extensions: loaded.map((entry) => entry.summary),
                commands: loaded.flatMap((entry) => entry.commands),
                keybindings,
                conflicts: findKeybindingConflicts(keybindings),
                failures: [...this.failures].map(([extensionId, reason]) => ({ extensionId, reason })),
            };
        }
        return this.cached;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private drop(extensionId: string): boolean {
        const entry = this.extensions.get(extensionId);
        if (entry === undefined) return false;
        for (const dispose of entry.disposers) dispose();
        for (const command of entry.commands) {
            this.owners.delete(command.id);
            this.whens.delete(command.id);
        }
        this.extensions.delete(extensionId);
        return true;
    }

    private changed(): void {
        this.cached = undefined;
        for (const listener of [...this.listeners]) listener();
    }
}
