import { expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { DesktopExtensionRegistry } from "../../clients/ui/src/extensions/contributions.ts";
import { parseDesktopManifest, type DesktopManifest } from "../../clients/ui/src/extensions/manifest.ts";
import { parseWhen, isWhenError, type WhenExpression } from "../../clients/ui/src/extensions/when.ts";
import { whenKeys, whensOverlap } from "../../clients/ui/src/extensions/when-analysis.ts";

interface Call {
    readonly extensionId: string;
    readonly commandId: string;
    readonly args: unknown;
}

function load(id: string, contributes: Record<string, unknown>, extra: Record<string, unknown> = {}): DesktopManifest {
    const result = parseDesktopManifest({ id, version: "1.0.0", engine: "vera-gui@^1", main: "./main.js", contributes, ...extra });
    if (!result.ok) throw new Error(result.reason);
    return result.manifest;
}

function setup() {
    const commands = new CommandRegistry();
    const calls: Call[] = [];
    const registry = new DesktopExtensionRegistry(commands, {
        activateAndRun: (extensionId, commandId, args) => {
            calls.push({ extensionId, commandId, args });
        },
    });
    return { commands, calls, registry };
}

function expression(source: string): WhenExpression {
    const parsed = parseWhen(source);
    if (isWhenError(parsed)) throw new Error(parsed.message);
    return parsed;
}

const THEMES = load("acme.themes", {
    commands: [
        { command: "acme.themes.import", title: "Import", category: "Theme", when: "view == 'settings' && acme.themes.ready" },
        { command: "acme.themes.reset", title: "Reset" },
    ],
    keybindings: [{ command: "acme.themes.import", key: "ctrl+alt+i", mac: "cmd+alt+i" }],
}, { main: "./main.js" });

test("adding an extension puts its commands in the shared registry and lists them", () => {
    const { commands, registry } = setup();

    expect(registry.add(THEMES)).toEqual({ ok: true });

    expect(commands.list().map((command) => [command.id, command.title])).toEqual([
        ["acme.themes.import", "Theme: Import"],
        ["acme.themes.reset", "Reset"],
    ]);
    const snapshot = registry.snapshot();
    expect(snapshot.extensions).toEqual([{ id: "acme.themes", version: "1.0.0", main: "./main.js" }]);
    expect(snapshot.commands.map((command) => command.id)).toEqual(["acme.themes.import", "acme.themes.reset"]);
    expect(snapshot.keybindings).toMatchObject([{ extensionId: "acme.themes", command: "acme.themes.import", key: "ctrl+alt+i", mac: "cmd+alt+i" }]);
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.failures).toEqual([]);
});

test("running a contributed command calls activateAndRun with the extension and command ids", () => {
    const { commands, calls, registry } = setup();
    registry.add(THEMES);

    expect(commands.execute("acme.themes.reset")).toBe(true);
    expect(commands.execute("acme.themes.import", { file: "crow.vsix" })).toBe(true);

    expect(calls).toEqual([
        { extensionId: "acme.themes", commandId: "acme.themes.reset", args: undefined },
        { extensionId: "acme.themes", commandId: "acme.themes.import", args: { file: "crow.vsix" } },
    ]);
});

test("removing an extension removes every entry it added and leaves the others", () => {
    const { commands, registry } = setup();
    registry.add(THEMES);
    registry.add(load("acme.snippets", { commands: [{ command: "acme.snippets.insert", title: "Insert" }] }));

    registry.remove("acme.themes");
    registry.remove("acme.themes");

    expect(commands.list().map((command) => command.id)).toEqual(["acme.snippets.insert"]);
    const snapshot = registry.snapshot();
    expect(snapshot.extensions.map((extension) => extension.id)).toEqual(["acme.snippets"]);
    expect(snapshot.commands.map((command) => command.id)).toEqual(["acme.snippets.insert"]);
    expect(snapshot.keybindings).toEqual([]);
    expect(registry.isVisible("acme.themes.import", new Map())).toBe(true);
});

test("adding an extension again replaces what it contributed before", () => {
    const { commands, registry } = setup();
    registry.add(THEMES);

    registry.add(load("acme.themes", { commands: [{ command: "acme.themes.other", title: "Other" }] }));

    expect(commands.list().map((command) => command.id)).toEqual(["acme.themes.other"]);
    expect(registry.snapshot().keybindings).toEqual([]);
});

test("when is evaluated per call, using the expression parsed with the manifest", () => {
    const { registry } = setup();
    registry.add(THEMES);
    const settings = new Map<string, string | boolean>([["view", "settings"], ["acme.themes.ready", true]]);

    expect(registry.isVisible("acme.themes.import", settings)).toBe(true);
    expect(registry.isVisible("acme.themes.import", new Map([["view", "settings"]]))).toBe(false);
    expect(registry.isVisible("acme.themes.import", new Map<string, string | boolean>([["view", "session"], ["acme.themes.ready", true]]))).toBe(false);
    expect(registry.isVisible("acme.themes.reset", new Map())).toBe(true);
    expect(registry.isVisible("session.new", new Map())).toBe(true);
});

test("a command that is a core command fails the extension and draws nothing", () => {
    const { commands, registry } = setup();
    commands.register({ id: "theme.import", title: "Theme: Import", run: () => undefined });

    const result = registry.add(load("theme", {
        commands: [
            { command: "theme.fine", title: "Fine" },
            { command: "theme.import", title: "Import" },
        ],
    }));

    expect(result).toEqual({ ok: false, extensionId: "theme", reason: 'Command "theme.import" is a core command.' });
    expect(commands.list().map((command) => command.id)).toEqual(["theme.import"]);
    const snapshot = registry.snapshot();
    expect(snapshot.extensions).toEqual([]);
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.failures).toEqual([{ extensionId: "theme", reason: 'Command "theme.import" is a core command.' }]);
});

test("a command id another extension already holds fails the later extension", () => {
    const { commands, registry } = setup();
    registry.add(load("acme", { commands: [{ command: "acme.themes.go", title: "Go" }] }));

    const result = registry.add(load("acme.themes", { commands: [{ command: "acme.themes.go", title: "Go too" }] }));

    expect(result).toEqual({ ok: false, extensionId: "acme.themes", reason: 'Command "acme.themes.go" is already contributed by extension acme.' });
    expect(commands.list().map((command) => command.title)).toEqual(["Go"]);
});

test("a later successful add or a remove clears the recorded failure", () => {
    const { commands, registry } = setup();
    commands.register({ id: "theme.import", title: "Import", run: () => undefined });
    const clash = load("theme", { commands: [{ command: "theme.import", title: "Import" }] });
    registry.add(clash);

    registry.add(load("theme", { commands: [{ command: "theme.other", title: "Other" }] }));
    expect(registry.snapshot().failures).toEqual([]);

    registry.add(clash);
    registry.remove("theme");
    expect(registry.snapshot().failures).toEqual([]);
});

test("fail records a manifest that did not load and removes what the extension drew", () => {
    const { commands, registry } = setup();
    registry.add(THEMES);

    const result = registry.fail("acme.themes", "Unknown manifest key \"x\".");

    expect(result).toEqual({ ok: false, extensionId: "acme.themes", reason: "Unknown manifest key \"x\"." });
    expect(commands.list()).toEqual([]);
    expect(registry.snapshot().failures).toEqual([{ extensionId: "acme.themes", reason: "Unknown manifest key \"x\"." }]);
});

test("the snapshot is the same object until something changes, and listeners hear each change", () => {
    const { registry } = setup();
    let heard = 0;
    const stop = registry.subscribe(() => {
        heard++;
    });

    expect(registry.snapshot()).toBe(registry.snapshot());
    registry.add(THEMES);
    registry.remove("acme.themes");
    registry.remove("acme.themes");
    stop();
    registry.add(THEMES);

    expect(heard).toBe(2);
});

test("two bindings on one key with absent or overlapping when are a conflict and both stay", () => {
    const { registry } = setup();
    registry.add(load("acme.a", {
        commands: [{ command: "acme.a.go", title: "A" }],
        keybindings: [{ command: "acme.a.go", key: "Ctrl+K  Ctrl+T" }],
    }));
    registry.add(load("acme.b", {
        commands: [{ command: "acme.b.go", title: "B" }],
        keybindings: [{ command: "acme.b.go", key: "ctrl+k ctrl+t", when: "view == 'session'" }],
    }));

    const snapshot = registry.snapshot();

    expect(snapshot.keybindings.map((binding) => binding.extensionId)).toEqual(["acme.a", "acme.b"]);
    expect(snapshot.conflicts).toHaveLength(1);
    const [conflict] = snapshot.conflicts;
    expect(conflict?.first).toMatchObject({ extensionId: "acme.a", command: "acme.a.go" });
    expect(conflict?.second).toMatchObject({ extensionId: "acme.b", command: "acme.b.go" });
    expect(conflict?.platforms).toEqual(["mac", "other"]);
});

test("bindings whose when clauses cannot both hold do not conflict", () => {
    const { registry } = setup();
    registry.add(load("acme.a", {
        commands: [{ command: "acme.a.go", title: "A" }],
        keybindings: [{ command: "acme.a.go", key: "f5", when: "view == 'session'" }],
    }));
    registry.add(load("acme.b", {
        commands: [{ command: "acme.b.go", title: "B" }],
        keybindings: [{ command: "acme.b.go", key: "f5", when: "view == 'settings'" }],
    }));

    expect(registry.snapshot().conflicts).toEqual([]);

    registry.add(load("acme.c", {
        commands: [{ command: "acme.c.go", title: "C" }],
        keybindings: [{ command: "acme.c.go", key: "f5", when: "view != 'session'" }],
    }));

    expect(registry.snapshot().conflicts.map((conflict) => [conflict.first.extensionId, conflict.second.extensionId])).toEqual([["acme.b", "acme.c"]]);
});

test("a mac override moves the conflict to the platform where the keys match", () => {
    const { registry } = setup();
    registry.add(load("acme.a", {
        commands: [{ command: "acme.a.go", title: "A" }],
        keybindings: [{ command: "acme.a.go", key: "ctrl+j", mac: "cmd+j" }],
    }));
    registry.add(load("acme.b", {
        commands: [{ command: "acme.b.go", title: "B" }],
        keybindings: [{ command: "acme.b.go", key: "ctrl+j", mac: "cmd+shift+j" }],
    }));

    expect(registry.snapshot().conflicts.map((conflict) => conflict.platforms)).toEqual([["other"]]);
});

test("two bindings inside one extension on the same key are also reported", () => {
    const { registry } = setup();
    registry.add(load("acme.a", {
        commands: [{ command: "acme.a.one", title: "One" }, { command: "acme.a.two", title: "Two" }],
        keybindings: [{ command: "acme.a.one", key: "f6" }, { command: "acme.a.two", key: "F6" }],
    }));

    expect(registry.snapshot().conflicts).toHaveLength(1);
});

test("removing an extension drops its conflicts", () => {
    const { registry } = setup();
    registry.add(load("acme.a", { commands: [{ command: "acme.a.go", title: "A" }], keybindings: [{ command: "acme.a.go", key: "f7" }] }));
    registry.add(load("acme.b", { commands: [{ command: "acme.b.go", title: "B" }], keybindings: [{ command: "acme.b.go", key: "f7" }] }));
    expect(registry.snapshot().conflicts).toHaveLength(1);

    registry.remove("acme.b");

    expect(registry.snapshot().conflicts).toEqual([]);
});

test("whenKeys lists every key a condition reads", () => {
    expect([...whenKeys(expression("view == 'a' && (!hasSession || x.y != 3) && z"))].sort()).toEqual(["hasSession", "view", "x.y", "z"]);
    expect([...whenKeys(expression("true"))]).toEqual([]);
    expect([...whenKeys(expression(""))]).toEqual([]);
});

test("whensOverlap is false only when no context satisfies both", () => {
    const overlap = (left: string, right: string) => whensOverlap(expression(left), expression(right));

    expect(overlap("view == 'a'", "view == 'b'")).toBe(false);
    expect(overlap("view == 'a'", "view != 'a'")).toBe(false);
    expect(overlap("view == 'a'", "!view")).toBe(false);
    expect(overlap("view == 'a'", "view")).toBe(true);
    expect(overlap("view == 'a'", "view != 'b'")).toBe(true);
    expect(overlap("view == 'a'", "hasSession")).toBe(true);
    expect(overlap("a && !a", "true")).toBe(false);
    expect(overlap("view != 'a'", "view != 'b'")).toBe(true);
    expect(overlap("view == 'a' || view == 'b'", "view == 'c'")).toBe(false);
    expect(overlap("sessionBusy == true", "!sessionBusy")).toBe(false);
    expect(overlap("true", "true")).toBe(true);
});

test("whensOverlap answers that two conditions with too many contexts may overlap", () => {
    const wide = (prefix: string) => expression(Array.from({ length: 14 }, (_, index) => `${prefix}${index} == 'x'`).join(" && "));

    expect(whensOverlap(wide("a"), wide("b"))).toBe(true);
});
