import { expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import type { ToWorker } from "../../clients/ui/src/extensions/envelope.ts";
import type { Timers, WorkerLink } from "../../clients/ui/src/extensions/runtime.ts";
import { DesktopExtensionSystem, type ExtensionBridge } from "../../clients/ui/src/extensions/system.ts";
import type { ExtensionFolder, ExtensionListResult } from "../../clients/ui/src/protocol/desktop-extensions.ts";

const NO_TIMERS: Timers = { set: () => 0, clear: () => undefined, now: () => 0 };

function manifest(id: string, contributes: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ id, version: "1.0.0", engine: "vera-gui@^1", main: "./main.js", contributes, ...extra });
}

const DEMO = manifest("demo", {
    commands: [
        { command: "demo.hello", title: "Hello" },
        { command: "demo.armedOnly", title: "Armed only", when: "demo.armed" },
        { command: "demo.settingsOnly", title: "Settings only", when: "view == 'settings'" },
    ],
    keybindings: [
        { command: "demo.hello", key: "ctrl+shift+y", mac: "cmd+shift+y" },
        { command: "demo.settingsOnly", key: "ctrl+shift+u", mac: "cmd+shift+u" },
    ],
});

interface Setup {
    readonly system: DesktopExtensionSystem;
    readonly commands: CommandRegistry;
    readonly ran: string[];
    readonly links: { readonly extensionId: string; readonly posted: ToWorker[] }[];
    readonly logs: string[];
    readonly toasts: string[];
}

async function setup(listing: ExtensionListResult | Error, platform = "darwin"): Promise<Setup> {
    const commands = new CommandRegistry();
    const ran: string[] = [];
    const links: Setup["links"][number][] = [];
    const logs: string[] = [];
    const toasts: string[] = [];
    commands.register({ id: "go.settings", title: "Go to Settings", run: () => undefined });
    const bridge: ExtensionBridge = {
        listDesktopExtensions: async () => {
            if (listing instanceof Error) throw listing;
            return listing;
        },
        readDesktopExtensionMain: async () => ({ ok: true, source: "export function activate() {}" }),
        logDesktopExtension: (extensionId, level, text) => {
            logs.push(`${extensionId} ${level} ${text}`);
        },
    };
    const system = new DesktopExtensionSystem({
        commands,
        bridge,
        platform,
        createLink: (extensionId): WorkerLink => {
            const link = { extensionId, posted: [] as ToWorker[] };
            links.push(link);
            return { post: (message) => link.posted.push(message), terminate: () => undefined };
        },
        toast: (text) => toasts.push(text),
        timers: NO_TIMERS,
    });
    const original = commands.execute.bind(commands);
    commands.execute = (id, args) => {
        ran.push(id);
        return original(id, args);
    };
    await system.load();
    return { system, commands, ran, links, logs, toasts };
}

function folders(...list: ExtensionFolder[]): ExtensionListResult {
    return { ok: true, folders: list, truncated: false };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function key(overrides: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean }>) {
    return { key: "y", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: null, ...overrides };
}

test("@core a valid manifest draws its commands before any extension code runs", async () => {
    const { system, commands, links } = await setup(folders({ directory: "demo", text: DEMO }));
    expect(commands.list().map((command) => command.id)).toEqual(["go.settings", "demo.hello", "demo.armedOnly", "demo.settingsOnly"]);
    expect(system.registry.snapshot().failures).toEqual([]);
    expect(system.runtime.snapshot()).toEqual([{ extensionId: "demo", state: "inactive" }]);
    expect(links).toHaveLength(0);
});

test("running a contributed command starts the extension's worker and sends the run", async () => {
    const { commands, links } = await setup(folders({ directory: "demo", text: DEMO }));
    expect(commands.execute("demo.hello")).toBe(true);
    await tick();
    expect(links).toHaveLength(1);
    expect(links[0]!.extensionId).toBe("demo");
    expect(links[0]!.posted[0]).toMatchObject({ type: "load", commands: ["demo.hello", "demo.armedOnly", "demo.settingsOnly"] });
});

test("@core a manifest that is invalid, a folder that does not match its id and one the shell could not read are listed as failed with reasons and draw nothing", async () => {
    const { system, commands, links } = await setup(folders(
        { directory: "broken", text: "{ nope" },
        { directory: "invalid", text: JSON.stringify({ id: "invalid" }) },
        { directory: "misnamed", text: manifest("other", { commands: [{ command: "other.one", title: "One" }] }) },
        { directory: "nomanifest", problem: "No vera.desktop.json in this folder." },
    ));
    const failures = system.registry.snapshot().failures;
    expect(failures.map((failure) => failure.extensionId).sort()).toEqual(["broken", "invalid", "misnamed", "nomanifest"]);
    expect(failures.find((failure) => failure.extensionId === "broken")?.reason).toBe("vera.desktop.json is not valid JSON.");
    expect(failures.find((failure) => failure.extensionId === "misnamed")?.reason).toBe('The folder name must match the extension id "other".');
    expect(failures.find((failure) => failure.extensionId === "nomanifest")?.reason).toBe("No vera.desktop.json in this folder.");
    expect(commands.list().map((command) => command.id)).toEqual(["go.settings"]);
    expect(system.runtime.snapshot()).toEqual([]);
    expect(links).toHaveLength(0);
});

test("@core a when clause that does not parse or names an unknown core key fails the extension", async () => {
    const { system, commands } = await setup(folders(
        { directory: "badparse", text: manifest("badparse", { commands: [{ command: "badparse.one", title: "One", when: "view ==" }] }) },
        { directory: "badkey", text: manifest("badkey", { commands: [{ command: "badkey.one", title: "One", when: "viewz == 'a'" }] }) },
    ));
    expect(system.registry.snapshot().failures.map((failure) => failure.extensionId).sort()).toEqual(["badkey", "badparse"]);
    expect(commands.list().map((command) => command.id)).toEqual(["go.settings"]);
});

test("@core a command id held by core or by another extension fails the extension that claims it", async () => {
    const { system, commands } = await setup(folders(
        { directory: "acme", text: manifest("acme", { commands: [{ command: "acme.themes.import", title: "One" }] }) },
        { directory: "acme.themes", text: manifest("acme.themes", { commands: [{ command: "acme.themes.import", title: "Two" }] }) },
        { directory: "go", text: manifest("go", { commands: [{ command: "go.settings", title: "Replace" }] }) },
    ));
    const failures = system.registry.snapshot().failures;
    expect(failures.map((failure) => failure.extensionId).sort()).toEqual(["acme.themes", "go"]);
    expect(failures.find((failure) => failure.extensionId === "go")?.reason).toBe('Command "go.settings" is a core command.');
    expect(commands.list().filter((command) => command.id === "go.settings")).toHaveLength(1);
    expect(commands.list().filter((command) => command.id === "acme.themes.import")).toHaveLength(1);
});

test("a keybinding that is a sequence or has no modifier fails the extension with the reason", async () => {
    const { system } = await setup(folders(
        { directory: "seq", text: manifest("seq", { commands: [{ command: "seq.one", title: "One" }], keybindings: [{ command: "seq.one", key: "ctrl+k ctrl+j" }] }) },
        { directory: "bare", text: manifest("bare", { commands: [{ command: "bare.one", title: "One" }], keybindings: [{ command: "bare.one", key: "y" }] }) },
    ));
    const failures = system.registry.snapshot().failures;
    expect(failures.find((failure) => failure.extensionId === "seq")?.reason).toBe('Keybinding for "seq.one": Key sequences are not supported.');
    expect(failures.find((failure) => failure.extensionId === "bare")?.reason).toBe('Keybinding for "bare.one": A key needs ctrl, alt or cmd, or must be a function key.');
});

test("a listing that fails, throws or is truncated sets a note", async () => {
    expect((await setup({ ok: false, reason: "The extensions folder could not be read." })).system.note).toBe("The extensions folder could not be read.");
    expect((await setup(new Error("ipc"))).system.note).toBe("The extensions folder could not be read.");
    const truncated = await setup({ ok: true, folders: [], truncated: true });
    expect(truncated.system.note).toBe("More extension folders exist than are loaded.");
    expect((await setup(folders())).system.note).toBeUndefined();
});

test("@core a command with a when clause is visible only while it holds, and the token changes when a key changes", async () => {
    const { system } = await setup(folders({ directory: "demo", text: DEMO }));
    const first = system.token();
    expect(system.isVisible("demo.hello")).toBe(true);
    expect(system.isVisible("demo.armedOnly")).toBe(false);
    expect(system.isVisible("go.settings")).toBe(true);
    expect(system.isVisible("demo.settingsOnly")).toBe(false);

    let heard = 0;
    system.subscribe(() => {
        heard += 1;
    });
    system.setFocus({ view: "settings", container: undefined, entryKind: undefined });
    expect(system.isVisible("demo.settingsOnly")).toBe(true);
    expect(system.token()).not.toBe(first);
    expect(heard).toBe(1);

    system.context.set("demo.armed", true);
    expect(system.isVisible("demo.armedOnly")).toBe(true);
    system.context.set("demo.armed", undefined);
    expect(system.isVisible("demo.armedOnly")).toBe(false);
});

test("session keys feed the context, and an unchanged value does not notify", async () => {
    const { system } = await setup(folders({ directory: "demo", text: DEMO }));
    let heard = 0;
    system.subscribe(() => {
        heard += 1;
    });
    system.setSession({ hasSession: true, sessionBusy: false });
    expect(heard).toBe(2);
    system.setSession({ hasSession: true, sessionBusy: false });
    expect(heard).toBe(2);
    const context = system.context.snapshot();
    expect(context.get("hasSession")).toBe(true);
    expect(context.get("sessionBusy")).toBe(false);
});

test("a bound key runs its command, using the mac key on macOS and the other key elsewhere", async () => {
    const mac = await setup(folders({ directory: "demo", text: DEMO }), "darwin");
    expect(mac.system.handleKey(key({ metaKey: true, shiftKey: true }))).toBe("demo.hello");
    expect(mac.system.handleKey(key({ ctrlKey: true, shiftKey: true }))).toBeUndefined();
    const other = await setup(folders({ directory: "demo", text: DEMO }), "linux");
    expect(other.system.handleKey(key({ ctrlKey: true, shiftKey: true }))).toBe("demo.hello");
    expect(other.system.handleKey(key({ metaKey: true, shiftKey: true }))).toBeUndefined();
});

test("a bound key does nothing while its command's when clause is false, then runs once it holds", async () => {
    const { system } = await setup(folders({ directory: "demo", text: DEMO }), "linux");
    const event = key({ key: "u", ctrlKey: true, shiftKey: true });
    expect(system.handleKey(event)).toBeUndefined();
    system.setFocus({ view: "settings", container: undefined, entryKind: undefined });
    expect(system.handleKey(event)).toBe("demo.settingsOnly");
});

test("key repeat and composition run nothing", async () => {
    const { system, ran } = await setup(folders({ directory: "demo", text: DEMO }), "linux");
    expect(system.handleKey(key({ ctrlKey: true, shiftKey: true, repeat: true }))).toBeUndefined();
    expect(system.handleKey(key({ ctrlKey: true, shiftKey: true, isComposing: true }))).toBeUndefined();
    expect(ran).toEqual([]);
});

test("@core two extensions bound to the same key with overlapping conditions run nothing, whatever the load order", async () => {
    const one = manifest("one", { commands: [{ command: "one.go", title: "One" }], keybindings: [{ command: "one.go", key: "ctrl+alt+j" }] });
    const two = manifest("two", { commands: [{ command: "two.go", title: "Two" }], keybindings: [{ command: "two.go", key: "ctrl+alt+j" }] });
    const event = key({ key: "j", ctrlKey: true, altKey: true });
    for (const order of [[{ directory: "one", text: one }, { directory: "two", text: two }], [{ directory: "two", text: two }, { directory: "one", text: one }]]) {
        const { system, ran } = await setup(folders(...order), "linux");
        expect(system.registry.snapshot().conflicts).toHaveLength(1);
        expect(system.handleKey(event)).toBeUndefined();
        expect(ran).toEqual([]);
    }
});

test("@core an extension binding on one of the desktop's own keys never runs, on either platform", async () => {
    const taken = manifest("taken", {
        commands: [{ command: "taken.go", title: "Go" }],
        keybindings: [{ command: "taken.go", key: "ctrl+k", mac: "cmd+k" }],
    });
    const mac = await setup(folders({ directory: "taken", text: taken }), "darwin");
    expect(mac.system.registry.snapshot().coreConflicts).toHaveLength(1);
    expect(mac.system.handleKey(key({ key: "k", metaKey: true }))).toBeUndefined();
    expect(mac.ran).toEqual([]);
    const other = await setup(folders({ directory: "taken", text: taken }), "linux");
    expect(other.system.handleKey(key({ key: "k", ctrlKey: true }))).toBeUndefined();
    expect(other.ran).toEqual([]);
});

test("a binding taken on one platform still runs on the other", async () => {
    const split = manifest("split", {
        commands: [{ command: "split.go", title: "Go" }],
        keybindings: [{ command: "split.go", key: "ctrl+b", mac: "ctrl+b" }],
    });
    const mac = await setup(folders({ directory: "split", text: split }), "darwin");
    expect(mac.system.handleKey(key({ key: "b", ctrlKey: true }))).toBe("split.go");
    const other = await setup(folders({ directory: "split", text: split }), "linux");
    expect(other.system.handleKey(key({ key: "b", ctrlKey: true }))).toBeUndefined();
});

test("disposing the system ends every worker", async () => {
    const { system, commands } = await setup(folders({ directory: "demo", text: DEMO }));
    commands.execute("demo.hello");
    await tick();
    expect(system.runtime.snapshot()[0]?.state).toBe("activating");
    system.dispose();
    expect(system.runtime.snapshot()[0]?.state).toBe("inactive");
});
