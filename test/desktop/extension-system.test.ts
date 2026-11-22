import { expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import type { ToWorker } from "../../clients/ui/src/extensions/envelope.ts";
import { parseDesktopManifest } from "../../clients/ui/src/extensions/manifest.ts";
import type { Timers, WorkerLink } from "../../clients/ui/src/extensions/runtime.ts";
import { DesktopExtensionSystem } from "../../clients/ui/src/extensions/system.ts";
import type { DesktopExtensionEntry } from "../../clients/ui/src/protocol/extensions.ts";

const NO_TIMERS: Timers = { set: () => 0, clear: () => undefined, now: () => 0 };

function entry(id: string, version: string, contributes: Record<string, unknown>, options: { enabled?: boolean; included?: boolean; main?: string } = {}): DesktopExtensionEntry {
    const parsed = parseDesktopManifest({ id, version, engine: "vera-gui@^1", main: options.main ?? "main.js", contributes });
    if (!parsed.ok) throw new Error(parsed.reason);
    const { manifest } = parsed;
    return {
        id,
        version,
        themes: [],
        hasMain: true,
        hasCommands: manifest.commands.length > 0,
        hasUnavailableContributions: false,
        ...(manifest.commands.some((command) => command.task === undefined && command.page === undefined) ? { worker: {
            main: manifest.main!,
            commands: manifest.commands.filter((command) => command.task === undefined && command.page === undefined).map(({ command, title, category, when }) => ({ command, title, ...(category === undefined ? {} : { category }), ...(when === undefined ? {} : { when: when.source }) })),
            keybindings: manifest.keybindings.map(({ command, key, mac, when }) => ({ command, key, ...(mac === undefined ? {} : { mac }), ...(when === undefined ? {} : { when: when.source }) })),
        } } : {}),
        commands: [],
        menus: { appearance: [], theme: [], browser: [] },
        included: options.included ?? false,
        enabled: options.enabled ?? true,
    };
}

const DEMO = entry("demo", "1.0.0", {
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
    readonly links: { readonly extensionId: string; readonly posted: ToWorker[]; readonly receive: (message: unknown) => void; readonly terminate: () => void; terminated: boolean }[];
    readonly logs: string[];
    readonly toasts: string[];
}

function setup(platform = "darwin"): Setup {
    const commands = new CommandRegistry();
    const ran: string[] = [];
    const links: Setup["links"][number][] = [];
    const logs: string[] = [];
    const toasts: string[] = [];
    commands.register({ id: "go.settings", title: "Go to Settings", run: () => undefined });
    const system = new DesktopExtensionSystem({
        commands,
        bridge: {
            readDesktopExtensionMain: async () => ({ ok: true, source: "export function activate() {}" }),
            logDesktopExtension: (extensionId, level, text) => logs.push(`${extensionId} ${level} ${text}`),
        },
        platform,
        createLink: (extensionId, receive): WorkerLink => {
            const link = { extensionId, posted: [] as ToWorker[], receive, terminated: false, terminate() { this.terminated = true; } };
            links.push(link);
            return { post: (message) => link.posted.push(message), terminate: () => link.terminate() };
        },
        toast: (text) => toasts.push(text),
        timers: NO_TIMERS,
    });
    const original = commands.execute.bind(commands);
    commands.execute = (id, args) => {
        ran.push(id);
        return original(id, args);
    };
    return { system, commands, ran, links, logs, toasts };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function key(overrides: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean }>) {
    return { key: "y", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: null, ...overrides };
}

test("a valid entry registers commands before starting its worker", () => {
    const { system, commands, links } = setup();
    system.sync([DEMO]);
    expect(commands.list().map((command) => command.id)).toEqual(["go.settings", "demo.hello", "demo.armedOnly", "demo.settingsOnly"]);
    expect(system.registry.snapshot().failures).toEqual([]);
    expect(system.runtime.snapshot()).toEqual([{ extensionId: "demo", state: "inactive" }]);
    expect(links).toHaveLength(0);
});

test("running a contributed command starts its worker and sends the declared commands", async () => {
    const { system, commands, links } = setup();
    system.sync([DEMO]);
    expect(commands.execute("demo.hello")).toBe(true);
    await tick();
    expect(links).toHaveLength(1);
    expect(links[0]!.posted[0]).toMatchObject({ type: "load", commands: ["demo.hello", "demo.armedOnly", "demo.settingsOnly"] });
});

test("disabled, included, and task or page-only entries contribute no worker commands", () => {
    const { system, commands, links } = setup();
    system.sync([
        entry("off", "1", { commands: [{ command: "off.run", title: "Off" }] }, { enabled: false }),
        entry("bundled", "1", { commands: [{ command: "bundled.run", title: "Bundled" }] }, { included: true }),
        entry("taskonly", "1", { tasks: [{ id: "job", title: "Job", main: "job.js" }], commands: [{ command: "taskonly.run", title: "Job", task: "job" }] }),
        entry("pageonly", "1", { commands: [{ command: "pageonly.run", title: "Page", page: "page.html" }] }),
    ]);
    expect(commands.list().map((command) => command.id)).toEqual(["go.settings"]);
    expect(system.runtime.snapshot()).toEqual([]);
    expect(links).toHaveLength(0);
});

test("@core a command with a when clause is visible only while it holds, and the token changes when a key changes", () => {
    const { system, ran } = setup("linux");
    system.sync([DEMO]);
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
    expect(system.handleKey(key({ key: "u", ctrlKey: true, shiftKey: true }))).toBe("demo.settingsOnly");

    system.context.set("demo.armed", true);
    expect(system.isVisible("demo.armedOnly")).toBe(true);
    expect(heard).toBe(2);
    system.context.set("demo.armed", undefined);
    expect(system.isVisible("demo.armedOnly")).toBe(false);
    expect(heard).toBe(3);
    expect(ran).toEqual(["demo.settingsOnly"]);
});

test("@core an extension binding on one of the desktop's own keys never runs, on either platform", () => {
    const { system, commands, ran } = setup();
    const ownKey = entry("taken", "1", { commands: [{ command: "taken.go", title: "Go" }], keybindings: [{ command: "taken.go", key: "ctrl+k", mac: "cmd+k" }] });
    const coreCommand = { ...entry("claims", "1", { commands: [{ command: "claims.replace", title: "Replace" }] }), worker: { ...entry("claims", "1", { commands: [{ command: "claims.replace", title: "Replace" }] }).worker!, commands: [{ command: "go.settings", title: "Replace" }] } };
    system.sync([ownKey, coreCommand]);
    expect(system.registry.snapshot().coreConflicts).toHaveLength(1);
    expect(system.registry.snapshot().failures.map((failure) => failure.extensionId)).toEqual(["claims"]);
    expect(system.handleKey(key({ key: "k", metaKey: true }))).toBeUndefined();
    expect(ran).toEqual([]);
    expect(commands.list().filter((item) => item.id === "go.settings")).toHaveLength(1);
    const other = setup("linux");
    other.system.sync([ownKey]);
    expect(other.system.handleKey(key({ key: "k", ctrlKey: true }))).toBeUndefined();
    expect(other.ran).toEqual([]);
});

test("@core two extensions bound to the same key with overlapping conditions run nothing, whatever the load order", () => {
    const one = entry("one", "1", { commands: [{ command: "one.go", title: "Go" }], keybindings: [{ command: "one.go", key: "ctrl+alt+j" }] });
    const two = entry("two", "1", { commands: [{ command: "two.go", title: "Go" }], keybindings: [{ command: "two.go", key: "ctrl+alt+j" }] });
    const invalid = { ...DEMO, worker: { ...DEMO.worker!, commands: [{ command: "bad".repeat(81), title: "Long" }] } };
    const event = key({ key: "j", ctrlKey: true, altKey: true });
    for (const order of [[one, two], [two, one]]) {
        const { system, ran } = setup("linux");
        system.sync([...order, invalid], undefined, [{ directory: "broken-folder", problem: "Invalid manifest." }]);
        expect(system.registry.snapshot().failures).toContainEqual({ extensionId: "broken-folder", reason: "Invalid manifest." });
        expect(system.registry.snapshot().conflicts).toHaveLength(1);
        expect(system.handleKey(event)).toBeUndefined();
        expect(system.registry.snapshot().failures.map((failure) => failure.extensionId)).toContain("demo");
        expect(ran).toEqual([]);
    }
});

test("the worker-command and command-id caps report author errors", () => {
    const { system } = setup();
    system.sync([
        { ...DEMO, worker: { ...DEMO.worker!, commands: Array.from({ length: 501 }, (_, index) => ({ command: `demo.c${index}`, title: "Command" })) } },
        { ...DEMO, id: "longid", worker: { ...DEMO.worker!, commands: [{ command: `longid.${"x".repeat(200)}`, title: "Long" }] } },
    ]);
    const failures = system.registry.snapshot().failures;
    expect(failures.find((failure) => failure.extensionId === "demo")?.reason).toContain("at most 500 worker commands");
    expect(failures.find((failure) => failure.extensionId === "longid")?.reason).toContain("at most 200 characters");
});

test("disabling or removing an active entry removes commands, worker and context without a toast", async () => {
    for (const next of [(current: DesktopExtensionEntry) => [{ ...current, enabled: false }], () => []]) {
        const { system, commands, links, toasts } = setup();
        system.sync([DEMO]);
        commands.execute("demo.hello");
        await tick();
        links[0]!.receive({ type: "loaded" });
        links[0]!.receive({ type: "context", key: "demo.armed", value: true });
        commands.execute("demo.armedOnly");
        system.sync(next(DEMO));
        expect(links[0]!.terminated).toBe(true);
        expect(system.context.snapshot().get("demo.armed")).toBeUndefined();
        expect(commands.list().map((command) => command.id)).not.toContain("demo.hello");
        expect(toasts).toEqual([]);
    }
});

test("replacement with the same version stops the old worker and the next run reads current code", async () => {
    let source = "old source";
    const commands = new CommandRegistry();
    const links: Setup["links"][number][] = [];
    const system = new DesktopExtensionSystem({
        commands,
        bridge: { readDesktopExtensionMain: async () => ({ ok: true as const, source }), logDesktopExtension: () => undefined },
        platform: "darwin",
        createLink: (extensionId, receive) => {
            const link = { extensionId, posted: [] as ToWorker[], receive, terminated: false, terminate() { this.terminated = true; } };
            links.push(link);
            return { post: (message) => link.posted.push(message), terminate: () => link.terminate() };
        },
        toast: () => undefined,
        timers: NO_TIMERS,
    });
    system.sync([DEMO]);
    commands.execute("demo.hello");
    await tick();
    expect(links[0]!.posted[0]).toMatchObject({ type: "load", source: "old source" });
    source = "new source";
    system.sync([DEMO], "demo");
    expect(links[0]!.terminated).toBe(true);
    commands.execute("demo.hello");
    await tick();
    expect(links[1]!.posted[0]).toMatchObject({ type: "load", source: "new source" });
});

test("disable cancels in-flight and queued commands without a toast", async () => {
    const { system, commands, links, toasts } = setup();
    system.sync([DEMO]);
    commands.execute("demo.hello");
    await tick();
    links[0]!.receive({ type: "loaded" });
    commands.execute("demo.armedOnly");
    expect(links[0]!.posted.filter((message) => message.type === "run")).toHaveLength(2);
    system.sync([{ ...DEMO, enabled: false }]);
    expect(links[0]!.terminated).toBe(true);
    expect(toasts).toEqual([]);
    links[0]!.receive({ type: "failed", call: 1, reason: "late failure" });
    expect(toasts).toEqual([]);
});

test("listing notes follow the authoritative snapshot", () => {
    const { system } = setup();
    system.sync([], undefined, [], "The extensions folder could not be read.");
    expect(system.note).toBe("The extensions folder could not be read.");
    system.sync([]);
    expect(system.note).toBeUndefined();
});

test("@core session keys feed the context, and an unchanged value does not notify", () => {
    const { system } = setup();
    system.sync([DEMO]);
    let heard = 0;
    system.subscribe(() => {
        heard += 1;
    });
    system.setSession({ hasSession: true, sessionBusy: false });
    const firstCount = heard;
    expect(firstCount).toBeGreaterThan(0);
    system.setSession({ hasSession: true, sessionBusy: false });
    expect(heard).toBe(firstCount);
    const context = system.context.snapshot();
    expect(context.get("hasSession")).toBe(true);
    expect(context.get("sessionBusy")).toBe(false);
});

test("@core a bound key runs its command, using the mac key on macOS and the other key elsewhere", () => {
    const mac = setup("darwin");
    mac.system.sync([DEMO]);
    expect(mac.system.handleKey(key({ metaKey: true, shiftKey: true }))).toBe("demo.hello");
    expect(mac.system.handleKey(key({ ctrlKey: true, shiftKey: true }))).toBeUndefined();
    const other = setup("linux");
    other.system.sync([DEMO]);
    expect(other.system.handleKey(key({ ctrlKey: true, shiftKey: true }))).toBe("demo.hello");
    expect(other.system.handleKey(key({ metaKey: true, shiftKey: true }))).toBeUndefined();
});

test("@core a binding taken on one platform still runs on the other", () => {
    const split = entry("split", "1", {
        commands: [{ command: "split.go", title: "Go" }],
        keybindings: [{ command: "split.go", key: "ctrl+b", mac: "ctrl+b" }],
    });
    const mac = setup("darwin");
    mac.system.sync([split]);
    expect(mac.system.handleKey(key({ key: "b", ctrlKey: true }))).toBe("split.go");
    const other = setup("linux");
    other.system.sync([split]);
    expect(other.system.handleKey(key({ key: "b", ctrlKey: true }))).toBeUndefined();
});

test("@core key repeat and composition run nothing", () => {
    const { system, ran } = setup("linux");
    system.sync([DEMO]);
    expect(system.handleKey(key({ ctrlKey: true, shiftKey: true, repeat: true }))).toBeUndefined();
    expect(system.handleKey(key({ ctrlKey: true, shiftKey: true, isComposing: true }))).toBeUndefined();
    expect(ran).toEqual([]);
});

test("@core a keybinding that is a sequence or has no modifier fails the extension with the reason", () => {
    const sequence = entry("seq", "1", { commands: [{ command: "seq.one", title: "One" }] });
    const bare = entry("bare", "1", { commands: [{ command: "bare.one", title: "One" }] });
    const { system } = setup();
    system.sync([
        { ...sequence, worker: { ...sequence.worker!, keybindings: [{ command: "seq.one", key: "ctrl+k ctrl+j" }] } },
        { ...bare, worker: { ...bare.worker!, keybindings: [{ command: "bare.one", key: "y" }] } },
    ]);
    const failures = system.registry.snapshot().failures;
    expect(failures.find((failure) => failure.extensionId === "seq")?.reason).toBe('Keybinding for "seq.one": Key sequences are not supported.');
    expect(failures.find((failure) => failure.extensionId === "bare")?.reason).toBe('Keybinding for "bare.one": A key needs ctrl, alt or cmd, or must be a function key.');
});

test("@core a when clause that does not parse or names an unknown core key fails the extension", () => {
    const badParse = entry("badparse", "1", { commands: [{ command: "badparse.one", title: "One" }] });
    const badKey = entry("badkey", "1", { commands: [{ command: "badkey.one", title: "One" }] });
    const { system, commands } = setup();
    system.sync([
        { ...badParse, worker: { ...badParse.worker!, commands: [{ command: "badparse.one", title: "One", when: "view ==" }] } },
        { ...badKey, worker: { ...badKey.worker!, commands: [{ command: "badkey.one", title: "One", when: "viewz == 'a'" }] } },
    ]);
    expect(system.registry.snapshot().failures.map((failure) => failure.extensionId).sort()).toEqual(["badkey", "badparse"]);
    expect(commands.list().map((command) => command.id)).toEqual(["go.settings"]);
});

test("@core a command id held by core or by another extension fails the extension that claims it", () => {
    const first = entry("first", "1", { commands: [{ command: "first.go", title: "Go" }] });
    const second = entry("second", "1", { commands: [{ command: "second.go", title: "Go" }] });
    const core = entry("go", "1", { commands: [{ command: "go.replace", title: "Replace" }] });
    const { system } = setup();
    system.sync([
        first,
        { ...second, worker: { ...second.worker!, commands: [{ command: "shared.go", title: "Go" }] } },
        { ...core, worker: { ...core.worker!, commands: [{ command: "go.settings", title: "Replace" }] } },
    ]);
    const failures = system.registry.snapshot().failures;
    expect(failures.map((failure) => failure.extensionId).sort()).toEqual(["go", "second"]);
    expect(failures.find((failure) => failure.extensionId === "go")?.reason).toBe('Command "go.settings" is a core command.');
});

test("dispose ends every worker", async () => {
    const { system, commands, links } = setup();
    system.sync([DEMO]);
    commands.execute("demo.hello");
    await tick();
    system.dispose();
    expect(links[0]!.terminated).toBe(true);
});
