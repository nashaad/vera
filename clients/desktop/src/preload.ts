import { contextBridge, ipcRenderer } from "electron";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import type { DesktopBridge, DesktopEvent } from "../../ui/src/protocol/bridge.ts";
import type { ThemeName } from "../../ui/src/theme/tokens.ts";
import { CHANNELS } from "./channels.ts";

const bridge: DesktopBridge = {
    platform: process.platform,
    start: () => ipcRenderer.send(CHANNELS.start),
    reconnect: () => ipcRenderer.send(CHANNELS.reconnect),
    answer: (id: string, yes: boolean) => ipcRenderer.send(CHANNELS.answer, { id, yes }),
    send: (text: string) => ipcRenderer.send(CHANNELS.send, text),
    setTitleBarHeight: (height: number) => ipcRenderer.send(CHANNELS.titleBar, height),
    setWindowBackground: (color: string) => ipcRenderer.send(CHANNELS.windowBackground, color),
    setTheme: (name: ThemeName) => ipcRenderer.send(CHANNELS.theme, name),
    loadLayout: async () => {
        const layout: unknown = await ipcRenderer.invoke(CHANNELS.layoutLoad);
        return (layout ?? undefined) as LayoutState | undefined;
    },
    saveLayout: (layout: LayoutState) => ipcRenderer.send(CHANNELS.layoutSave, layout),
    onEvent: (listener: (event: DesktopEvent) => void) => {
        const handler = (_event: unknown, payload: DesktopEvent): void => listener(payload);
        ipcRenderer.on(CHANNELS.event, handler);
        return () => ipcRenderer.off(CHANNELS.event, handler);
    },
};

contextBridge.exposeInMainWorld("veraDesktop", bridge);
