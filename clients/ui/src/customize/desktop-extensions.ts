import { setDesktopExtensions } from "../extensions/state.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import type { ExtensionChangeResult, ExtensionPreviewResult } from "../protocol/extensions.ts";
import { applyThemeList } from "../theme/sync.ts";

export const LIST_FAILED = "Vera could not read the desktop extensions.";
export const CHANGE_FAILED = "Vera could not change that extension.";
export const PACKAGE_UNREAD = "Vera could not read that package.";

export async function readExtensions(bridge: DesktopBridge): Promise<ExtensionChangeResult> {
    try {
        const result = await bridge.listDesktopExtensions();
        if (result.ok) setDesktopExtensions(result.extensions);
        return result;
    } catch {
        return { ok: false, reason: LIST_FAILED };
    }
}

// Reads which extensions are on, for what an extension adds to the window outside Customize.
export async function syncDesktopExtensions(bridge: DesktopBridge | undefined = globalThis.window?.veraDesktop): Promise<void> {
    if (bridge !== undefined) await readExtensions(bridge);
}

// Every change hands back the extensions and the themes of the enabled ones. Both are applied here, so the stored
// theme and the commands an extension adds follow it being removed or turned off even when the page that asked has gone.
async function change(request: () => Promise<ExtensionChangeResult>): Promise<ExtensionChangeResult> {
    try {
        const result = await request();
        if (result.ok) {
            setDesktopExtensions(result.extensions);
            applyThemeList(result.themes);
        }
        return result;
    } catch {
        return { ok: false, reason: CHANGE_FAILED };
    }
}

export function installExtension(bridge: DesktopBridge, token: string): Promise<ExtensionChangeResult> {
    return change(() => bridge.installDesktopExtension(token));
}

export function toggleExtension(bridge: DesktopBridge, id: string, enabled: boolean): Promise<ExtensionChangeResult> {
    return change(() => bridge.setDesktopExtensionEnabled(id, enabled));
}

export function removeExtension(bridge: DesktopBridge, id: string): Promise<ExtensionChangeResult> {
    return change(() => bridge.removeDesktopExtension(id));
}

export async function previewExtension(bridge: DesktopBridge): Promise<ExtensionPreviewResult> {
    try {
        return await bridge.previewDesktopExtension();
    } catch {
        return { ok: false, reason: PACKAGE_UNREAD };
    }
}
