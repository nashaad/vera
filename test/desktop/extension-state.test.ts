import { afterEach, expect, test } from "bun:test";

import { THEME_IMPORT_COMMAND, THEME_IMPORTER_ID } from "../../clients/ui/src/extensions/theme-importer.ts";
import { readExtensions, syncDesktopExtensions, toggleExtension } from "../../clients/ui/src/customize/desktop-extensions.ts";
import { isExtensionOn, setDesktopExtensions, subscribeDesktopExtensions } from "../../clients/ui/src/extensions/state.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { DesktopExtensionEntry, ExtensionChangeResult } from "../../clients/ui/src/protocol/extensions.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerThemeCommands } from "../../clients/ui/src/commands/theme-commands.ts";

afterEach(() => setDesktopExtensions([]));

function importer(enabled: boolean): DesktopExtensionEntry {
    return { id: THEME_IMPORTER_ID, version: "1.0.0", themes: [], hasMain: true, hasCommands: true, included: true, enabled };
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

test("@core the import command is in the palette only while the importer is on", () => {
    const registry = new CommandRegistry();
    const register = (on: boolean) => registerThemeCommands(registry, () => {}, [], on ? () => {} : undefined);
    expect(registry.list().some((command) => command.id === THEME_IMPORT_COMMAND)).toBe(false);
    const dispose = register(true);
    expect(registry.list().find((command) => command.id === THEME_IMPORT_COMMAND)?.title).toBe("Theme: Import VS Code Theme…");
    dispose();
    register(false);
    expect(registry.list().some((command) => command.id === THEME_IMPORT_COMMAND)).toBe(false);
});
