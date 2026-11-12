import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import type {
    CreateSessionResult,
    DesktopBridge,
    DesktopEvent,
    HostModelsResult,
    ModelOperationKind,
    ModelOperationResult,
} from "../../ui/src/protocol/bridge.ts";
import type { ThemeName } from "../../ui/src/theme/tokens.ts";
import { CHANNELS } from "./channels.ts";

const bridge: DesktopBridge = {
    platform: process.platform,
    start: () => ipcRenderer.send(CHANNELS.start),
    reconnect: () => ipcRenderer.send(CHANNELS.reconnect),
    answer: (id: string, yes: boolean) => ipcRenderer.send(CHANNELS.answer, { id, yes }),
    send: (text: string) => ipcRenderer.send(CHANNELS.send, text),
    watchSession: (agentId: string) => ipcRenderer.send(CHANNELS.sessionWatch, agentId),
    sendSession: (text: string) => ipcRenderer.send(CHANNELS.sessionSend, text),
    unwatchSession: () => ipcRenderer.send(CHANNELS.sessionUnwatch),
    setTitleBarHeight: (height: number) => ipcRenderer.send(CHANNELS.titleBar, height),
    setWindowBackground: (color: string) => ipcRenderer.send(CHANNELS.windowBackground, color),
    setTheme: (name: ThemeName) => ipcRenderer.send(CHANNELS.theme, name),
    loadLayout: async () => {
        const layout: unknown = await ipcRenderer.invoke(CHANNELS.layoutLoad);
        return (layout ?? undefined) as LayoutState | undefined;
    },
    saveLayout: (layout: LayoutState) => ipcRenderer.send(CHANNELS.layoutSave, layout),
    createSession: async (workspace: string, approvalMode?: string) => {
        const result: unknown = await ipcRenderer.invoke(CHANNELS.sessionCreate, workspace, approvalMode);
        return result as CreateSessionResult;
    },
    chooseFolder: async () => {
        const folder: unknown = await ipcRenderer.invoke(CHANNELS.folderChoose);
        return typeof folder === "string" ? folder : undefined;
    },
    chooseImages: async () => {
        const paths: unknown = await ipcRenderer.invoke(CHANNELS.imagesChoose);
        return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
    },
    pathForFile: (file: File) => {
        const path = webUtils.getPathForFile(file);
        return path.length === 0 ? undefined : path;
    },
    savePastedImage: async (data: Uint8Array, mediaType: string) => {
        const path: unknown = await ipcRenderer.invoke(CHANNELS.imagePaste, data, mediaType);
        return typeof path === "string" ? path : undefined;
    },
    readBranch: async (folder: string) => {
        const branch: unknown = await ipcRenderer.invoke(CHANNELS.branchRead, folder);
        return typeof branch === "string" ? branch : undefined;
    },
    readModelSettings: async (workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.modelsRead, workspace)) as HostModelsResult,
    refreshCatalog: async (provider: string, workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.catalogRefresh, provider, workspace)) as HostModelsResult,
    forgetProvider: async (provider: string, workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.providerForget, provider, workspace)) as HostModelsResult,
    operateModel: async (operation: ModelOperationKind, provider: string, model: string, workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.modelOperate, operation, provider, model, workspace)) as ModelOperationResult,
    onEvent: (listener: (event: DesktopEvent) => void) => {
        const handler = (_event: unknown, payload: DesktopEvent): void => listener(payload);
        ipcRenderer.on(CHANNELS.event, handler);
        return () => ipcRenderer.off(CHANNELS.event, handler);
    },
};

contextBridge.exposeInMainWorld("veraDesktop", bridge);
