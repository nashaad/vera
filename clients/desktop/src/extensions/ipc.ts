import { dialog, ipcMain, type BrowserWindow, type WebContents } from "electron";

import type { ExtensionChangeResult, ExtensionPreviewResult } from "../../../ui/src/protocol/extensions.ts";
import { CHANNELS } from "../channels.ts";
import type { ExtensionService } from "./service.ts";

const MAX_TOKEN_CHARS = 64;
const MAX_ID_CHARS = 80;
const NOT_THE_WINDOW = "That window cannot change desktop extensions.";

interface Wiring {
    readonly service: ExtensionService;
    readonly window: () => BrowserWindow | undefined;
    readonly fromWindow: (event: { readonly sender: WebContents }) => boolean;
}

function text(value: unknown, limit: number): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

// The file picker lives here, in the main process; the package is read in a task process.
export function registerExtensionHandlers({ service, window, fromWindow }: Wiring): void {
    const refused: { readonly ok: false; readonly reason: string } = { ok: false, reason: NOT_THE_WINDOW };
    ipcMain.handle(CHANNELS.desktopExtensionsList, (event): ExtensionChangeResult => (fromWindow(event) ? service.list() : refused));
    ipcMain.handle(CHANNELS.desktopExtensionPreview, async (event): Promise<ExtensionPreviewResult> => {
        const parent = window();
        if (!fromWindow(event) || parent === undefined) return refused;
        const result = await dialog.showOpenDialog(parent, {
            properties: ["openFile"],
            filters: [{ name: "Desktop extension packages", extensions: ["tgz", "gz"] }],
        });
        const path = result.filePaths[0];
        if (result.canceled || path === undefined) return { ok: true, preview: undefined };
        return service.preview(path);
    });
    ipcMain.handle(CHANNELS.desktopExtensionInstall, (event, token: unknown): ExtensionChangeResult => {
        const valid = text(token, MAX_TOKEN_CHARS);
        return fromWindow(event) && valid !== undefined ? service.confirm(valid) : refused;
    });
    ipcMain.on(CHANNELS.desktopExtensionCancel, (event, token: unknown) => {
        const valid = text(token, MAX_TOKEN_CHARS);
        if (fromWindow(event) && valid !== undefined) service.cancel(valid);
    });
    ipcMain.handle(CHANNELS.desktopExtensionEnable, (event, id: unknown, enabled: unknown): ExtensionChangeResult => {
        const valid = text(id, MAX_ID_CHARS);
        return fromWindow(event) && valid !== undefined && typeof enabled === "boolean" ? service.setEnabled(valid, enabled) : refused;
    });
    ipcMain.handle(CHANNELS.desktopExtensionRemove, (event, id: unknown): ExtensionChangeResult => {
        const valid = text(id, MAX_ID_CHARS);
        return fromWindow(event) && valid !== undefined ? service.remove(valid) : refused;
    });
}
