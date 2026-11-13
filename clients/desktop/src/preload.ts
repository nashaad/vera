import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import type { AssignAllResult, AssignmentChange, AssignmentsResult, AssignmentWriteResult } from "../../ui/src/protocol/assignments.ts";
import type { SavedPins } from "../../ui/src/protocol/pins.ts";
import type { DesktopFlags } from "../../ui/src/state/desktopFlags.ts";
import type {
    AnnexPagesResult,
    BranchSessionResult,
    CloseSessionResult,
    CreateSessionResult,
    DesktopBridge,
    DesktopEvent,
    ExtensionFailuresResult,
    FilePreview,
    FolderListing,
    HostModelsResult,
    ModelOperationKind,
    ModelOperationResult,
    SessionSearchRequest,
    SessionSearchResult,
    SessionPane,
} from "../../ui/src/protocol/bridge.ts";
import type { ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import type { InstalledThemesResult, ThemeImportResult } from "../../ui/src/protocol/themes.ts";
import type { ThemeChoice } from "../../ui/src/theme/tokens.ts";
import { CHANNELS } from "./channels.ts";

const bridge: DesktopBridge = {
    platform: process.platform,
    start: () => ipcRenderer.send(CHANNELS.start),
    reconnect: () => ipcRenderer.send(CHANNELS.reconnect),
    answer: (id: string, yes: boolean) => ipcRenderer.send(CHANNELS.answer, { id, yes }),
    send: (text: string) => ipcRenderer.send(CHANNELS.send, text),
    watchSession: (pane: SessionPane, agentId: string) => ipcRenderer.send(CHANNELS.sessionWatch, pane, agentId),
    sendSession: (pane: SessionPane, text: string) => ipcRenderer.send(CHANNELS.sessionSend, pane, text),
    unwatchSession: (pane: SessionPane) => ipcRenderer.send(CHANNELS.sessionUnwatch, pane),
    setTitleBarHeight: (height: number) => ipcRenderer.send(CHANNELS.titleBar, height),
    setWindowBackground: (color: string) => ipcRenderer.send(CHANNELS.windowBackground, color),
    setTheme: (choice: ThemeChoice) => ipcRenderer.send(CHANNELS.theme, choice),
    loadImportedThemes: async () => (await ipcRenderer.invoke(CHANNELS.themesLoad)) as readonly ImportedThemeSummary[],
    importTheme: async () => (await ipcRenderer.invoke(CHANNELS.themeImport)) as ThemeImportResult,
    listInstalledThemes: async () => (await ipcRenderer.invoke(CHANNELS.themesInstalled)) as InstalledThemesResult,
    importInstalledTheme: async (key: string) =>
        (await ipcRenderer.invoke(CHANNELS.themeInstalledImport, key)) as ThemeImportResult,
    loadLayout: async () => {
        const layout: unknown = await ipcRenderer.invoke(CHANNELS.layoutLoad);
        return (layout ?? undefined) as LayoutState | undefined;
    },
    saveLayout: (layout: LayoutState) => ipcRenderer.send(CHANNELS.layoutSave, layout),
    loadPins: async () => (await ipcRenderer.invoke(CHANNELS.pinsLoad)) as SavedPins,
    savePins: (pins: SavedPins) => ipcRenderer.send(CHANNELS.pinsSave, pins),
    loadFlags: async () => (await ipcRenderer.invoke(CHANNELS.flagsLoad)) as DesktopFlags,
    createSession: async (workspace: string | undefined, approvalMode?: string) => {
        const result: unknown = await ipcRenderer.invoke(CHANNELS.sessionCreate, workspace, approvalMode);
        return result as CreateSessionResult;
    },
    branchSession: async (agentId: string, boundaryId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionBranch, agentId, boundaryId)) as BranchSessionResult,
    cloneSession: async (agentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionClone, agentId)) as BranchSessionResult,
    closeSession: async (agentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionClose, agentId)) as CloseSessionResult,
    existingFolders: async (folders: readonly string[]) => {
        const found: unknown = await ipcRenderer.invoke(CHANNELS.foldersExisting, folders);
        return Array.isArray(found) ? found.filter((path): path is string => typeof path === "string") : [];
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
    listFolder: async (folder: string) => (await ipcRenderer.invoke(CHANNELS.folderList, folder)) as FolderListing,
    readFilePreview: async (path: string) => (await ipcRenderer.invoke(CHANNELS.fileRead, path)) as FilePreview,
    readModelSettings: async (workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.modelsRead, workspace)) as HostModelsResult,
    refreshCatalog: async (provider: string, workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.catalogRefresh, provider, workspace)) as HostModelsResult,
    forgetProvider: async (provider: string, workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.providerForget, provider, workspace)) as HostModelsResult,
    operateModel: async (operation: ModelOperationKind, provider: string, model: string, workspace?: string) =>
        (await ipcRenderer.invoke(CHANNELS.modelOperate, operation, provider, model, workspace)) as ModelOperationResult,
    readAssignments: async () => (await ipcRenderer.invoke(CHANNELS.assignmentsRead)) as AssignmentsResult,
    editAssignment: async (change: AssignmentChange) =>
        (await ipcRenderer.invoke(CHANNELS.assignmentsEdit, change)) as AssignmentWriteResult,
    assignToAll: async (provider: string, model: string) =>
        (await ipcRenderer.invoke(CHANNELS.assignmentsAll, provider, model)) as AssignAllResult,
    searchSessions: async (request: SessionSearchRequest) =>
        (await ipcRenderer.invoke(CHANNELS.sessionsSearch, request)) as SessionSearchResult,
    readExtensionFailures: async () =>
        (await ipcRenderer.invoke(CHANNELS.extensionFailures)) as ExtensionFailuresResult,
    readAnnexPages: async () => (await ipcRenderer.invoke(CHANNELS.annexPages)) as AnnexPagesResult,
    openAnnexPage: async (path: string) => (await ipcRenderer.invoke(CHANNELS.annexOpen, path)) === true,
    revealFolder: async (folder: string) => (await ipcRenderer.invoke(CHANNELS.folderReveal, folder)) === true,
    onEvent: (listener: (event: DesktopEvent) => void) => {
        const handler = (_event: unknown, payload: DesktopEvent): void => listener(payload);
        ipcRenderer.on(CHANNELS.event, handler);
        return () => ipcRenderer.off(CHANNELS.event, handler);
    },
};

contextBridge.exposeInMainWorld("veraDesktop", bridge);
