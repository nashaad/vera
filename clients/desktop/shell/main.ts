import { app, BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";

import { clearDesktopShell, publishDesktopShell } from "../../../src/release/desktop-shell.ts";
import { packageFailedMessage, resolveShellBoot, SHELL_API } from "./bootstrap.ts";
import { noticePage } from "./notice.ts";

// The desktop code is the package for the host build `current` names. The shell only finds it, holds it and loads its entry.
function showNotice(message: string): void {
    app.on("window-all-closed", () => app.quit());
    void app.whenReady().then(() => {
        const window = new BrowserWindow({
            width: 560,
            height: 240,
            title: "Vera",
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(noticePage(message))}`);
    });
}

const launcher = process.env.VERA_DESKTOP_LAUNCHER?.trim();
const boot = resolveShellBoot(launcher === undefined || launcher.length === 0 ? {} : { launcher });
if (boot.kind === "unavailable") {
    showNotice(boot.message);
} else {
    process.once("exit", boot.release);
    publishDesktopShell({
        shellApi: SHELL_API,
        prefix: boot.prefix,
        hostBuildId: boot.package.hostBuildId,
        desktopVersion: boot.package.desktopVersion,
        release: boot.release,
    });
    try {
        await import(pathToFileURL(boot.package.entryPath).href);
    } catch (error) {
        clearDesktopShell();
        boot.release();
        showNotice(packageFailedMessage(boot.package.hostBuildId, error instanceof Error ? error.message : String(error)));
    }
}
