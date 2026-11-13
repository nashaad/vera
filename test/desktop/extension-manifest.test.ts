import { expect, test } from "bun:test";

import { CORE_WHEN_KEYS, parseDesktopManifest, type ManifestResult } from "../../clients/ui/src/extensions/manifest.ts";

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: "acme.themes", version: "1.2.0", engine: "vera-gui@^1", main: "./main.js", ...patch };
}

function failure(result: ManifestResult): { extensionId?: string; reason: string } {
    if (result.ok) throw new Error("expected the manifest to fail");
    return result;
}

const IMPORT = { command: "acme.themes.import", title: " Import a theme ", category: "Theme", when: "view == 'settings' && acme.themes.ready" };

test("a manifest with a main module, commands and keybindings loads", () => {
    const result = parseDesktopManifest(manifest({
        main: "./dist/main.js",
        contributes: {
            commands: [IMPORT, { command: "acme.themes.reset", title: "Reset" }],
            keybindings: [
                { command: "acme.themes.import", key: "ctrl+alt+i", mac: "cmd+alt+i", when: "!sessionBusy" },
                { command: "acme.themes.reset", key: "f5" },
            ],
        },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({ id: "acme.themes", version: "1.2.0", engine: "vera-gui@^1", main: "./dist/main.js" });
    expect(result.manifest.commands.map((command) => [command.command, command.title, command.category, command.when?.source])).toEqual([
        ["acme.themes.import", "Import a theme", "Theme", "view == 'settings' && acme.themes.ready"],
        ["acme.themes.reset", "Reset", undefined, undefined],
    ]);
    expect(result.manifest.commands[0]?.when?.expression.kind).toBe("and");
    expect(result.manifest.keybindings[0]).toMatchObject({ command: "acme.themes.import", key: "ctrl+alt+i", mac: "cmd+alt+i" });
    expect(result.manifest.keybindings[1]).not.toHaveProperty("mac");
    expect(result.manifest.keybindings[1]).not.toHaveProperty("when");
});

test("a manifest with no contributions and no main is valid", () => {
    const result = parseDesktopManifest({ id: "acme.themes", version: "1.2.0", engine: "vera-gui@^1", contributes: {} });

    expect(result).toEqual({
        ok: true,
        manifest: { id: "acme.themes", version: "1.2.0", engine: "vera-gui@^1", commands: [], keybindings: [] },
    });
});

test("a manifest that contributes commands must name its main module", () => {
    const { main: _main, ...withoutMain } = manifest({ contributes: { commands: [{ command: "acme.themes.go", title: "Go" }] } });
    const result = failure(parseDesktopManifest(withoutMain));

    expect(result).toMatchObject({ extensionId: "acme.themes", reason: '"main" is required when the manifest contributes commands.' });
    expect(parseDesktopManifest({ ...withoutMain, contributes: { commands: [] } }).ok).toBe(true);
});

test("an extension id uses lowercase letters, digits, dashes and inner dots", () => {
    for (const id of ["a", "acme", "acme.themes", "acme-2.themes-x", "0", "a.b.c"]) {
        expect(parseDesktopManifest(manifest({ id })).ok, id).toBe(true);
    }
    for (const id of [".acme", "acme.", "Acme", "acme_themes", "acme themes", "", "acme/themes", 7, null, undefined]) {
        const result = failure(parseDesktopManifest(manifest({ id })));
        expect(result.reason, String(id)).toContain('"id" must use lowercase letters');
        expect(result.extensionId, String(id)).toBeUndefined();
    }
});

test("only the vera-gui@^1 engine is accepted", () => {
    for (const engine of ["vera-gui@^2", "vera-gui@1", "vera-gui@^1.2", "vera-gui", "vscode@^1", ""]) {
        const result = failure(parseDesktopManifest(manifest({ engine })));
        expect(result.reason, engine).toBe(`Engine "${engine}" is not supported; this Vera runs vera-gui@^1.`);
        expect(result.extensionId).toBe("acme.themes");
    }
    expect(failure(parseDesktopManifest(manifest({ engine: undefined }))).reason).toContain('"engine" must be the string "vera-gui@^1"');
    expect(failure(parseDesktopManifest(manifest({ engine: 1 }))).reason).toContain('"engine" must be the string');
});

test("a manifest needs an object shape, a version, and no unknown keys", () => {
    for (const value of [null, undefined, "x", 3, [], [manifest()]]) {
        expect(failure(parseDesktopManifest(value)).reason).toBe("The manifest must be a JSON object.");
    }
    for (const version of [undefined, "", "  ", 2]) {
        expect(failure(parseDesktopManifest(manifest({ version }))).reason).toBe('"version" must be a non-empty string.');
    }
    expect(parseDesktopManifest(manifest({ entrypoint: "./x.js" }))).toEqual({
        ok: false,
        extensionId: "acme.themes",
        reason: 'Unknown manifest key "entrypoint".',
    });
});

test("main must be a relative path that stays inside the extension", () => {
    for (const main of ["/abs/main.js", "../main.js", "a/../../main.js", "a\\..\\main.js", "\\\\host\\share", "C:\\main.js", "", "  ", 3, ["main.js"]]) {
        expect(failure(parseDesktopManifest(manifest({ main }))).reason, String(main)).toBe('"main" must be a relative file path inside the extension.');
    }
    expect(parseDesktopManifest(manifest({ main: " ./..hidden/main.js " }))).toMatchObject({ ok: true, manifest: { main: "./..hidden/main.js" } });
});

test("an unknown contribution kind or a wrong container type fails with a reason", () => {
    expect(failure(parseDesktopManifest(manifest({ contributes: { themes: [] } }))).reason).toBe('Unknown contribution kind "themes".');
    expect(failure(parseDesktopManifest(manifest({ contributes: [] }))).reason).toContain('"contributes" must be an object');
    expect(failure(parseDesktopManifest(manifest({ contributes: { commands: IMPORT } }))).reason).toBe('"contributes.commands" must be an array.');
    expect(failure(parseDesktopManifest(manifest({ contributes: { keybindings: {} } }))).reason).toBe('"contributes.keybindings" must be an array.');
});

test("a command id starts with the extension id and a dot", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
        ["theme.import", 'Command "theme.import" must start with "acme.themes.".'],
        ["acme.themes", 'Command "acme.themes" must start with "acme.themes.".'],
        ["acme.themes.", 'Command "acme.themes." must start with "acme.themes.".'],
        ["acme.themesx.go", 'Command "acme.themesx.go" must start with "acme.themes.".'],
        ["acme.themes.go now", "A command id must be a non-empty string without whitespace."],
        ["", "A command id must be a non-empty string without whitespace."],
        [4, "A command id must be a non-empty string without whitespace."],
    ];
    for (const [command, reason] of cases) {
        const result = failure(parseDesktopManifest(manifest({ contributes: { commands: [{ command, title: "T" }] } })));
        expect(result.reason, String(command)).toBe(reason);
        expect(result.extensionId).toBe("acme.themes");
    }
});

test("duplicate command ids, bad titles and bad categories fail the manifest", () => {
    const base = { command: "acme.themes.go", title: "Go" };
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
        ["duplicate id", [base, base], 'Command "acme.themes.go" is declared twice.'],
        ["not an object", ["acme.themes.go"], "A command contribution must be an object."],
        ["missing title", [{ command: base.command }], 'Command "acme.themes.go" needs a title of 1 to 100 characters.'],
        ["empty title", [{ ...base, title: "  " }], 'Command "acme.themes.go" needs a title of 1 to 100 characters.'],
        ["long title", [{ ...base, title: "x".repeat(101) }], 'Command "acme.themes.go" needs a title of 1 to 100 characters.'],
        ["title not a string", [{ ...base, title: 3 }], 'Command "acme.themes.go" needs a title'],
        ["empty category", [{ ...base, category: "" }], 'Command "acme.themes.go" needs a category of 1 to 40 characters.'],
        ["category not a string", [{ ...base, category: [] }], 'Command "acme.themes.go" needs a category'],
        ["when not a string", [{ ...base, when: true }], 'The when clause of command "acme.themes.go" must be a string.'],
    ];
    for (const [name, commands, reason] of cases) {
        expect(failure(parseDesktopManifest(manifest({ contributes: { commands } }))).reason, name).toContain(reason);
    }
});

test("a keybinding must name a declared command and carry a key", () => {
    const commands = [{ command: "acme.themes.go", title: "Go" }];
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
        ["not an object", ["f5"], "A keybinding contribution must be an object."],
        ["no command", [{ key: "f5" }], "A keybinding must name a command."],
        ["unknown command", [{ command: "acme.themes.nope", key: "f5" }], 'Keybinding names command "acme.themes.nope", which this manifest does not declare.'],
        ["no key", [{ command: "acme.themes.go" }], 'Keybinding for "acme.themes.go" needs a non-empty key.'],
        ["empty key", [{ command: "acme.themes.go", key: " " }], 'needs a non-empty key.'],
        ["key not a string", [{ command: "acme.themes.go", key: 1 }], 'needs a non-empty key.'],
        ["empty mac", [{ command: "acme.themes.go", key: "f5", mac: "" }], "needs a non-empty mac key when mac is set."],
        ["when not a string", [{ command: "acme.themes.go", key: "f5", when: 1 }], 'The when clause of keybinding for "acme.themes.go" must be a string.'],
    ];
    for (const [name, keybindings, reason] of cases) {
        expect(failure(parseDesktopManifest(manifest({ contributes: { commands, keybindings } }))).reason, name).toContain(reason);
    }
    expect(failure(parseDesktopManifest(manifest({ contributes: { keybindings: [{ command: "acme.themes.go", key: "f5" }] } }))).reason)
        .toContain("which this manifest does not declare");
});

test("a when clause that does not parse fails the whole manifest with the reason", () => {
    const commands = [
        { command: "acme.themes.ok", title: "Fine" },
        { command: "acme.themes.go", title: "Go", when: "view ==" },
    ];
    const result = failure(parseDesktopManifest(manifest({ contributes: { commands } })));

    expect(result.extensionId).toBe("acme.themes");
    expect(result.reason).toContain('The when clause of command "acme.themes.go" is invalid:');
    expect(result.reason).toContain("at character");

    const keybinding = failure(parseDesktopManifest(manifest({
        contributes: { commands: [commands[0]], keybindings: [{ command: "acme.themes.ok", key: "f5", when: "a &" }] },
    })));
    expect(keybinding.reason).toContain('The when clause of keybinding for "acme.themes.ok" is invalid:');
});

test("a when clause may read core keys and keys prefixed with the extension id only", () => {
    for (const key of CORE_WHEN_KEYS) {
        const when = `${key} == 'x' || !${key}`;
        expect(parseDesktopManifest(manifest({ contributes: { commands: [{ command: "acme.themes.go", title: "Go", when }] } })).ok, key).toBe(true);
    }
    const own = parseDesktopManifest(manifest({
        contributes: { commands: [{ command: "acme.themes.go", title: "Go", when: "(acme.themes.ready && !acme.themes.busy) || acme.themes.mode != 'x'" }] },
    }));
    expect(own.ok).toBe(true);

    for (const when of ["editorFocus", "view == 'a' && other.key", "acme.themesx.ready", "acme.ready", "!(hasSession && nested.key == 1)"]) {
        const result = failure(parseDesktopManifest(manifest({ contributes: { commands: [{ command: "acme.themes.go", title: "Go", when }] } })));
        expect(result.reason, when).toContain("which is neither a core key (view, container, entryKind, sessionBusy, hasSession) nor prefixed \"acme.themes.\".");
    }
    const binding = failure(parseDesktopManifest(manifest({
        contributes: {
            commands: [{ command: "acme.themes.go", title: "Go" }],
            keybindings: [{ command: "acme.themes.go", key: "f5", when: "elsewhere" }],
        },
    })));
    expect(binding.reason).toContain('The when clause of keybinding for "acme.themes.go" reads key "elsewhere"');
});

test("the parser reports failures and never throws", () => {
    for (const value of [undefined, null, 1, "x", [], {}, { id: "a" }, { id: "a", version: "1", engine: "vera-gui@^1", contributes: { commands: [null] } }]) {
        expect(() => parseDesktopManifest(value)).not.toThrow();
    }
});
