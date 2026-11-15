import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import type { AssignAllResult, AssignmentChange, AssignmentsResult, AssignmentWriteResult } from "../../ui/src/protocol/assignments.ts";
import type { SavedPins } from "../../ui/src/protocol/pins.ts";
import type { MoveSessionOutcome } from "../../ui/src/protocol/sessionMove.ts";
import type { DesktopFlags, FlagPatch } from "../../ui/src/state/desktopFlags.ts";
import type {
    AnnexPagesResult,
    BranchSessionResult,
    CloseSessionResult,
    CreateSessionResult,
    DesktopBridge,
    FeedbackSaveRequest,
    FeedbackSaveResult,
    DesktopEvent,
    ExtensionFailuresResult,
    FilePreview,
    FolderListing,
    HostModelsResult,
    ModelOperationKind,
    ModelOperationResult,
    ProviderListResult,
    ProviderResult,
    ProviderSave,
    SessionSearchRequest,
    SessionSearchResult,
    SessionPane,
} from "../../ui/src/protocol/bridge.ts";
import type { ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import type { CatalogListResult, CatalogPreviewResult } from "../../ui/src/protocol/extension-catalog.ts";
import type { ExtensionChangeResult, ExtensionPreviewResult } from "../../ui/src/protocol/extensions.ts";
import type { InstalledThemesResult, ThemeImportResult } from "../../ui/src/protocol/themes.ts";
import type { ThemeChoice } from "../../ui/src/theme/tokens.ts";
import type { BrowserBounds, BrowserState } from "../../ui/src/browser/native-types.ts";
import { CHANNELS } from "./channels.ts";

const bridge: DesktopBridge = {
    platform: process.platform,
    captureFeedback: async () => (await ipcRenderer.invoke(CHANNELS.feedbackCapture)) as string | undefined,
    saveFeedback: async (request: FeedbackSaveRequest) => (await ipcRenderer.invoke(CHANNELS.feedbackSave, request)) as FeedbackSaveResult,
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
    listDesktopExtensions: async () => (await ipcRenderer.invoke(CHANNELS.desktopExtensionsList)) as ExtensionChangeResult,
    previewDesktopExtension: async () => (await ipcRenderer.invoke(CHANNELS.desktopExtensionPreview)) as ExtensionPreviewResult,
    installDesktopExtension: async (token: string) =>
        (await ipcRenderer.invoke(CHANNELS.desktopExtensionInstall, token)) as ExtensionChangeResult,
    cancelDesktopExtension: (token: string) => ipcRenderer.send(CHANNELS.desktopExtensionCancel, token),
    setDesktopExtensionEnabled: async (id: string, enabled: boolean) =>
        (await ipcRenderer.invoke(CHANNELS.desktopExtensionEnable, id, enabled)) as ExtensionChangeResult,
    removeDesktopExtension: async (id: string) =>
        (await ipcRenderer.invoke(CHANNELS.desktopExtensionRemove, id)) as ExtensionChangeResult,
    openExtensionCatalog: async () => (await ipcRenderer.invoke(CHANNELS.extensionCatalogOpen)) as CatalogListResult,
    previewCatalogTheme: async (id: string) =>
        (await ipcRenderer.invoke(CHANNELS.extensionCatalogPreview, id)) as CatalogPreviewResult,
    closeExtensionCatalog: () => ipcRenderer.send(CHANNELS.extensionCatalogClose),
    loadLayout: async () => {
        const layout: unknown = await ipcRenderer.invoke(CHANNELS.layoutLoad);
        return (layout ?? undefined) as LayoutState | undefined;
    },
    saveLayout: (layout: LayoutState) => ipcRenderer.send(CHANNELS.layoutSave, layout),
    loadPins: async () => (await ipcRenderer.invoke(CHANNELS.pinsLoad)) as SavedPins,
    savePins: (pins: SavedPins) => ipcRenderer.send(CHANNELS.pinsSave, pins),
    loadFlags: async () => (await ipcRenderer.invoke(CHANNELS.flagsLoad)) as DesktopFlags,
    saveFlags: async (patch: FlagPatch) => ((await ipcRenderer.invoke(CHANNELS.flagsSave, patch)) ?? undefined) as DesktopFlags | undefined,
    reportHiddenCommands: (ids: readonly string[]) => ipcRenderer.send(CHANNELS.flagsHidden, ids),
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
    moveSession: async (agentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionMove, agentId)) as MoveSessionOutcome,
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
    checkComposerFile: async (path: string, workspace: string | undefined, chat: boolean) =>
        await ipcRenderer.invoke(CHANNELS.filesCheck, path, workspace, chat),
    prepareComposerFiles: async (paths: readonly string[], workspace: string, chat: boolean) =>
        await ipcRenderer.invoke(CHANNELS.filesPrepare, paths, workspace, chat),
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
    listProviders: async () => (await ipcRenderer.invoke(CHANNELS.providerList)) as ProviderListResult,
    saveProvider: async (input: ProviderSave) => (await ipcRenderer.invoke(CHANNELS.providerSave, input)) as ProviderResult,
    selectProviderModel: async (provider: string, model: string) =>
        (await ipcRenderer.invoke(CHANNELS.providerSelectModel, provider, model)) as { readonly ok: true } | { readonly ok: false; readonly reason: string },
    signInProvider: async (provider: string) => (await ipcRenderer.invoke(CHANNELS.providerSignIn, provider)) as ProviderResult,
    cancelProviderSignIn: () => ipcRenderer.send(CHANNELS.providerSignInCancel),
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
    browser: async (command: string, value?: string | number | boolean | null | BrowserBounds) =>
        (await ipcRenderer.invoke(CHANNELS.browser, command, value)) as BrowserState,
    revealFolder: async (folder: string) => (await ipcRenderer.invoke(CHANNELS.folderReveal, folder)) === true,
    onEvent: (listener: (event: DesktopEvent) => void) => {
        const handler = (_event: unknown, payload: DesktopEvent): void => listener(payload);
        ipcRenderer.on(CHANNELS.event, handler);
        return () => ipcRenderer.off(CHANNELS.event, handler);
    },
};

contextBridge.exposeInMainWorld("veraDesktop", bridge);
