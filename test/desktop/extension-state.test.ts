import { afterEach, expect, test } from "bun:test";

import { readExtensions, syncDesktopExtensions, toggleExtension } from "../../clients/ui/src/customize/desktop-extensions.ts";
import { isExtensionOn, setDesktopExtensions, subscribeDesktopExtensions } from "../../clients/ui/src/extensions/state.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { DesktopExtensionEntry, ExtensionChangeResult } from "../../clients/ui/src/protocol/extensions.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerExtensionCommands } from "../../clients/ui/src/extensions/commands.ts";

afterEach(() => setDesktopExtensions([]));

const THEME_IMPORTER_ID = "vera.vscode-theme-import";
const THEME_IMPORT_COMMAND = `${THEME_IMPORTER_ID}.import`;

function importer(enabled: boolean): DesktopExtensionEntry {
    return {
        id: THEME_IMPORTER_ID,
        version: "1.0.0",
        themes: [],
        hasMain: true,
        hasCommands: true,
        hasUnavailableContributions: false,
        commands: [{ id: THEME_IMPORT_COMMAND, title: "Import VS Code Theme…", category: "Theme" }],
        menus: { appearance: [], theme: [], browser: [] },
        included: true,
        enabled,
    };
}

function bridge(answer: ExtensionChangeResult): DesktopBridge {
    return {
        listDesktopExtensions: () => Promise.resolve(answer),
        setDesktopExtensionEnabled: () => Promise.resolve(answer),
    } as unknown as DesktopBridge;
}

test("@core nothing an extension adds shows until the list has been read, and it follows the switch", async () => {
    expect(isExtensionOn(THEME_IMPORTER_ID)).toBe(false);
    await syncDesktopExtensions(bridge({ ok: true, extensions: [importer(true)], themes: [] }));
    expect(isExtensionOn(THEME_IMPORTER_ID)).toBe(true);
    await toggleExtension(bridge({ ok: true, extensions: [importer(false)], themes: [] }), THEME_IMPORTER_ID, false);
    expect(isExtensionOn(THEME_IMPORTER_ID)).toBe(false);
    await toggleExtension(bridge({ ok: true, extensions: [importer(true)], themes: [] }), THEME_IMPORTER_ID, true);
    expect(isExtensionOn(THEME_IMPORTER_ID)).toBe(true);
});

test("a failed list leaves what the window knew, and a window with no bridge reads nothing", async () => {
    setDesktopExtensions([importer(true)]);
    const failing = { listDesktopExtensions: () => Promise.reject(new Error("ipc closed")) } as unknown as DesktopBridge;
    expect((await readExtensions(failing)).ok).toBe(false);
    expect(isExtensionOn(THEME_IMPORTER_ID)).toBe(true);
    await syncDesktopExtensions(undefined);
    expect(isExtensionOn(THEME_IMPORTER_ID)).toBe(true);
});

test("listeners hear each answer until they unsubscribe", () => {
    let heard = 0;
    const stop = subscribeDesktopExtensions(() => { heard += 1; });
    setDesktopExtensions([importer(true)]);
    setDesktopExtensions([importer(false)]);
    stop();
    setDesktopExtensions([importer(true)]);
    expect(heard).toBe(2);
});

test("@core a command is in the palette only while its extension is on, and a command already registered is left alone", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    expect(registry.list().some((command) => command.id === THEME_IMPORT_COMMAND)).toBe(false);
    const dispose = registerExtensionCommands(registry, [importer(true)], (command) => ran.push(command));
    expect(registry.list().find((command) => command.id === THEME_IMPORT_COMMAND)?.title).toBe("Theme: Import VS Code Theme…");
    registry.execute(THEME_IMPORT_COMMAND);
    expect(ran).toEqual([THEME_IMPORT_COMMAND]);
    expect(registerExtensionCommands(registry, [importer(true)], () => {})).toBeInstanceOf(Function);
    dispose();
    expect(registry.list().some((command) => command.id === THEME_IMPORT_COMMAND)).toBe(false);
    registerExtensionCommands(registry, [importer(false)], () => {});
    expect(registry.list().some((command) => command.id === THEME_IMPORT_COMMAND)).toBe(false);
});
