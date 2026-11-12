import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { selectedVeraHome } from "../../../src/profile-paths.ts";
import type { DesktopEvent } from "../../ui/src/protocol/bridge.ts";
import { BootSession } from "./boot.ts";
import { CHANNELS } from "./channels.ts";
import { HostPipe } from "./host-pipe.ts";
import { parseWindowBackground } from "./window-background.ts";

const MAX_SEND_BYTES = 1_048_576;
const TRAFFIC_LIGHT_INSET_X = 14;
const TRAFFIC_LIGHT_SIZE = 14;
const TITLE_BAR_HEIGHT_RANGE = { min: 24, max: 96 };

// Chromium's default userData sits outside VERA_HOME; keep a trial home self-contained.
const userData = join(selectedVeraHome(), "runtime", "desktop");
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);

let window: BrowserWindow | undefined;
let boot: BootSession | undefined;
let stopping = false;

const pipe = new HostPipe(sendEvent);

function sendEvent(event: DesktopEvent): void {
    if (window === undefined || window.isDestroyed()) return;
    window.webContents.send(CHANNELS.event, event);
}

function receiveEvent(event: DesktopEvent): void {
    sendEvent(event);
    if (event.type === "ready") pipe.connect(event.socketPath);
}

function startBoot(): void {
    boot?.cancel();
    pipe.close();
    boot = new BootSession(selectedVeraHome(), receiveEvent);
    boot.start();
}

function shutdown(): void {
    if (stopping) return;
    stopping = true;
    boot?.cancel();
    boot = undefined;
    pipe.close();
}

function fromWindow(event: IpcMainEvent): boolean {
    return window !== undefined && event.sender === window.webContents;
}

function trafficLightPosition(titleBarHeight: number): { x: number; y: number } {
    return {
        x: TRAFFIC_LIGHT_INSET_X,
        y: Math.max(0, Math.round((titleBarHeight - TRAFFIC_LIGHT_SIZE) / 2)),
    };
}

function createWindow(): BrowserWindow {
    const created = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 720,
        minHeight: 480,
        show: false,
        title: "Vera",
        // The page draws its own title bar on macOS; other platforms keep the system one.
        ...(process.platform === "darwin"
            ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLightPosition(36) }
            : {}),
        webPreferences: {
            preload: join(import.meta.dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    created.once("ready-to-show", () => created.show());
    // The window only ever shows the bundled page.
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("close", shutdown);
    created.on("closed", () => {
        if (window === created) window = undefined;
    });
    void created.loadFile(join(import.meta.dirname, "renderer", "index.html"));
    return created;
}

ipcMain.on(CHANNELS.start, (event) => {
    if (fromWindow(event)) startBoot();
});
ipcMain.on(CHANNELS.reconnect, (event) => {
    if (fromWindow(event)) startBoot();
});
ipcMain.on(CHANNELS.answer, (event, payload: unknown) => {
    if (!fromWindow(event) || typeof payload !== "object" || payload === null) return;
    const answer = payload as { id?: unknown; yes?: unknown };
    if (typeof answer.id !== "string" || typeof answer.yes !== "boolean") return;
    boot?.answer(answer.id, answer.yes);
});
ipcMain.on(CHANNELS.send, (event, text: unknown) => {
    if (!fromWindow(event) || typeof text !== "string" || text.length > MAX_SEND_BYTES) return;
    pipe.send(text);
});
ipcMain.on(CHANNELS.titleBar, (event, height: unknown) => {
    if (!fromWindow(event) || process.platform !== "darwin") return;
    if (typeof height !== "number" || !Number.isFinite(height)) return;
    const clamped = Math.min(Math.max(height, TITLE_BAR_HEIGHT_RANGE.min), TITLE_BAR_HEIGHT_RANGE.max);
    window?.setWindowButtonPosition(trafficLightPosition(clamped));
});
ipcMain.on(CHANNELS.windowBackground, (event, value: unknown) => {
    if (!fromWindow(event)) return;
    const color = parseWindowBackground(value);
    if (color !== undefined) window?.setBackgroundColor(color);
});

app.on("before-quit", shutdown);
app.on("window-all-closed", () => app.quit());
app.whenReady().then(() => {
    window = createWindow();
});
