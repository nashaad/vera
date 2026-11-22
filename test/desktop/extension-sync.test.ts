import { expect, test } from "bun:test";

import { readExtensions, toggleExtension } from "../../clients/ui/src/customize/desktop-extensions.ts";
import { desktopExtensionDiagnostics, desktopExtensions } from "../../clients/ui/src/extensions/state.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { DesktopExtensionEntry, ExtensionChangeResult } from "../../clients/ui/src/protocol/extensions.ts";

function extension(enabled: boolean): DesktopExtensionEntry {
    return {
        id: "demo", version: "1", themes: [], hasMain: true, hasCommands: true, hasUnavailableContributions: false,
        commands: [], menus: { appearance: [], theme: [], browser: [] }, included: false, enabled,
    };
}

test("a late list cannot restore an extension after it was turned off", async () => {
    let answer: (result: ExtensionChangeResult) => void = () => undefined;
    const listing = new Promise<ExtensionChangeResult>((resolve) => { answer = resolve; });
    const bridge = {
        listDesktopExtensions: () => listing,
        setDesktopExtensionEnabled: async () => ({
            ok: true as const, extensions: [extension(false)], themes: [],
            diagnostics: [{ directory: "broken", problem: "Invalid manifest." }],
        }),
    } as unknown as DesktopBridge;
    const pending = readExtensions(bridge);
    await toggleExtension(bridge, "demo", false);
    answer({ ok: true, extensions: [extension(true)], themes: [] });
    const result = await pending;
    expect(result.ok && result.extensions[0]?.enabled).toBe(false);
    expect(desktopExtensions()?.[0]?.enabled).toBe(false);
    expect(desktopExtensionDiagnostics()).toEqual([{ directory: "broken", problem: "Invalid manifest." }]);
});
