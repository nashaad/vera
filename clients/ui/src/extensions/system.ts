import type { CommandRegistry } from "../commands/registry.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { chordMatches, parseChord, type Chord, type ChordEvent } from "./chords.ts";
import { ContextKeys, readFocusKeys, type FocusKeys } from "./context.ts";
import { DesktopExtensionRegistry } from "./contributions.ts";
import type { ToastTone } from "./envelope.ts";
import { parseDesktopManifest, type DesktopManifest } from "./manifest.ts";
import { ExtensionRuntime, type ExtensionDefinition, type Timers, type WorkerLink } from "./runtime.ts";
import type { ContributedKeybinding, KeyPlatform } from "./keybindings.ts";
import { evaluateWhen } from "./when.ts";

export type ExtensionBridge = Pick<DesktopBridge, "listDesktopExtensions" | "readDesktopExtensionMain" | "logDesktopExtension">;

export interface SystemOptions {
    readonly commands: CommandRegistry;
    readonly bridge: ExtensionBridge;
    readonly platform: string;
    readonly createLink: (extensionId: string, receive: (data: unknown) => void) => WorkerLink;
    readonly toast: (text: string, tone: ToastTone) => void;
    readonly timers?: Timers;
}

export interface SessionKeys {
    readonly hasSession: boolean;
    readonly sessionBusy: boolean;
}

export interface KeyEventLike extends ChordEvent {
    readonly target: EventTarget | null;
    readonly repeat?: boolean;
    readonly isComposing?: boolean;
}

interface BoundChord {
    readonly binding: ContributedKeybinding;
    readonly chord: Chord;
}

const REAL_TIMERS: Timers = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
};

// Ties the pieces together for one window: folders become contributions, contributions become palette
// entries and key bindings, and a command run reaches the extension's worker.
export class DesktopExtensionSystem {
    readonly context = new ContextKeys();
    readonly registry: DesktopExtensionRegistry;
    readonly runtime: ExtensionRuntime;
    private readonly options: SystemOptions;
    private readonly listeners = new Set<() => void>();
    private version = {};
    private bound: { readonly source: unknown; readonly chords: readonly BoundChord[] } | undefined;
    private noteText: string | undefined;

    constructor(options: SystemOptions) {
        this.options = options;
        this.runtime = new ExtensionRuntime({
            readSource: (extensionId, main) => options.bridge.readDesktopExtensionMain(extensionId, main),
            createLink: options.createLink,
            toast: options.toast,
            log: (extensionId, level, text) => options.bridge.logDesktopExtension(extensionId, level, text),
            setContext: (key, value) => this.context.set(key, value),
            timers: options.timers ?? REAL_TIMERS,
        });
        this.registry = new DesktopExtensionRegistry(options.commands, {
            activateAndRun: (extensionId, commandId, args) => this.runtime.run(extensionId, commandId, args),
        });
        this.context.subscribe(() => this.changed());
        this.registry.subscribe(() => this.changed());
    }

    // A new object whenever a command may have appeared, gone or changed visibility.
    readonly token = (): object => this.version;

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    // A line about the listing as a whole, for the Extensions sheet. Set when folders could not all be read.
    get note(): string | undefined {
        return this.noteText;
    }

    // Reads the extensions folder and registers what is valid. Core commands must already be registered.
    async load(): Promise<void> {
        let listing;
        try {
            listing = await this.options.bridge.listDesktopExtensions();
        } catch {
            listing = { ok: false, reason: "The extensions folder could not be read." } as const;
        }
        if (!listing.ok) {
            this.setNote(listing.reason);
            return;
        }
        this.setNote(listing.truncated ? "More extension folders exist than are loaded." : undefined);
        const defined: ExtensionDefinition[] = [];
        for (const folder of listing.folders) {
            if (folder.text === undefined) {
                this.registry.fail(folder.directory, folder.problem ?? "The manifest could not be read.");
                continue;
            }
            const manifest = this.read(folder.directory, folder.text);
            if (manifest === undefined) continue;
            if (!this.registry.add(manifest).ok) continue;
            defined.push({ id: manifest.id, ...(manifest.main === undefined ? {} : { main: manifest.main }), commands: manifest.commands.map((entry) => entry.command) });
        }
        this.runtime.define(defined);
    }

    // The core keys. An unset key is false in a when clause and equals nothing.
    setFocus(keys: FocusKeys): void {
        this.context.set("view", keys.view);
        this.context.set("container", keys.container);
        this.context.set("entryKind", keys.entryKind);
    }

    setSession(keys: SessionKeys): void {
        this.context.set("hasSession", keys.hasSession);
        this.context.set("sessionBusy", keys.sessionBusy);
    }

    // False when the command belongs to an extension and its when clause does not hold.
    isVisible(commandId: string): boolean {
        return this.registry.isVisible(commandId, this.context.snapshot());
    }

    // Runs the one extension command bound to the key. Two matching bindings run nothing: load order never settles a conflict.
    // A binding on one of the desktop's own keys never runs.
    // Returns the command it ran, so the caller can stop the key from reaching the page.
    handleKey(event: KeyEventLike): string | undefined {
        if (event.repeat === true || event.isComposing === true) return undefined;
        if (typeof Element !== "undefined" && event.target instanceof Element && readFocusKeys(event.target) === undefined) return undefined;
        const context = this.context.snapshot();
        const matches = this.chords().filter(({ binding, chord }) =>
            chordMatches(chord, event)
            && (binding.when === undefined || evaluateWhen(binding.when, context))
            && this.registry.isVisible(binding.command, context));
        if (matches.length !== 1) return undefined;
        const command = matches[0]!.binding.command;
        return this.options.commands.execute(command) ? command : undefined;
    }

    // Closing the window ends every worker.
    dispose(): void {
        this.runtime.stopAll();
    }

    private chords(): readonly BoundChord[] {
        const snapshot = this.registry.snapshot();
        if (this.bound?.source !== snapshot) {
            const mac = this.options.platform === "darwin";
            const platform: KeyPlatform = mac ? "mac" : "other";
            const taken = new Set(snapshot.coreConflicts
                .filter((conflict) => conflict.platforms.includes(platform))
                .map((conflict) => conflict.binding));
            const chords: BoundChord[] = [];
            for (const binding of snapshot.keybindings) {
                if (taken.has(binding)) continue;
                const chord = parseChord(mac ? binding.mac ?? binding.key : binding.key);
                if (typeof chord !== "string") chords.push({ binding, chord });
            }
            this.bound = { source: snapshot, chords };
        }
        return this.bound.chords;
    }

    private read(directory: string, text: string): DesktopManifest | undefined {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            this.registry.fail(directory, "vera.desktop.json is not valid JSON.");
            return undefined;
        }
        const result = parseDesktopManifest(value);
        if (!result.ok) {
            this.registry.fail(result.extensionId ?? directory, result.reason);
            return undefined;
        }
        const { manifest } = result;
        if (manifest.id !== directory) {
            this.registry.fail(directory, `The folder name must match the extension id "${manifest.id}".`);
            return undefined;
        }
        for (const binding of manifest.keybindings) {
            for (const key of binding.mac === undefined ? [binding.key] : [binding.key, binding.mac]) {
                const chord = parseChord(key);
                if (typeof chord === "string") {
                    this.registry.fail(manifest.id, `Keybinding for "${binding.command}": ${chord}`);
                    return undefined;
                }
            }
        }
        return manifest;
    }

    private setNote(text: string | undefined): void {
        if (this.noteText === text) return;
        this.noteText = text;
        this.changed();
    }

    private changed(): void {
        this.version = {};
        for (const listener of [...this.listeners]) listener();
    }
}
