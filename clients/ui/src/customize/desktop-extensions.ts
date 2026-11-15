import type { DesktopBridge } from "../protocol/bridge.ts";
import type { ExtensionChangeResult, ExtensionPreviewResult } from "../protocol/extensions.ts";
import { applyThemeList } from "../theme/sync.ts";

export const LIST_FAILED = "Vera could not read the desktop extensions.";
export const CHANGE_FAILED = "Vera could not change that extension.";
export const PACKAGE_UNREAD = "Vera could not read that package.";

export async function readExtensions(bridge: DesktopBridge): Promise<ExtensionChangeResult> {
    try {
        return await bridge.listDesktopExtensions();
    } catch {
        return { ok: false, reason: LIST_FAILED };
    }
}

// Every change hands back the themes of the enabled extensions. They are applied here, so the stored theme
// follows its extension being removed or turned off even when the page that asked has gone.
async function change(request: () => Promise<ExtensionChangeResult>): Promise<ExtensionChangeResult> {
    try {
        const result = await request();
        if (result.ok) applyThemeList(result.themes);
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
