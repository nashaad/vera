import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import type { AssignAllResult, AssignmentChange, AssignmentsResult, AssignmentWriteResult } from "../../ui/src/protocol/assignments.ts";
import type { IncludedExtensionsResult } from "../../ui/src/protocol/included-extensions.ts";
import type { SavedPins } from "../../ui/src/protocol/pins.ts";
import type { MoveSessionOutcome } from "../../ui/src/protocol/sessionMove.ts";
import type { DesktopFlags, FlagPatch } from "../../ui/src/state/desktopFlags.ts";
import type {
    AnnexPagesResult,
    BranchSessionResult,
    OpenSidekickResult,
    SyncSidekickResult,
    CloseSessionResult,
    CreateSessionResult,
    DesktopBridge,
    FeedbackSaveRequest,
    FeedbackSaveResult,
    DesktopEvent,
    ExtensionFailuresResult,
    FolderCustomizationsResult,
    NewSessionAgentsResult,
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
import type { UpdateAction, UpdateState } from "../../ui/src/protocol/updates.ts";
import type { ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import type { CatalogListResult, CatalogPreviewResult } from "../../ui/src/protocol/extension-catalog.ts";
import type { ExtensionChangeResult, ExtensionPreviewResult } from "../../ui/src/protocol/extensions.ts";
import type { ExtensionCommandResult } from "../../ui/src/protocol/extension-commands.ts";
import type { ExtensionLogLevel, ExtensionMainResult } from "../../ui/src/protocol/desktop-extensions.ts";
import type {
    StorageCleaned,
    StorageCleanupArea,
    StorageMeasured,
    StoragePreviewed,
} from "../../ui/src/protocol/storage.ts";
import type { ThemeChoice } from "../../ui/src/theme/tokens.ts";
import type { BrowserBounds, BrowserHandoffAnswer, BrowserState, BrowserToolsApproval } from "../../ui/src/browser/native-types.ts";
import { CHANNELS } from "./channels.ts";

const bridge: DesktopBridge = {
    platform: process.platform,
    captureFeedback: async () => (await ipcRenderer.invoke(CHANNELS.feedbackCapture)) as string | undefined,
    saveFeedback: async (request: FeedbackSaveRequest) => (await ipcRenderer.invoke(CHANNELS.feedbackSave, request)) as FeedbackSaveResult,
    consumeWindowClose: () => ipcRenderer.sendSync(CHANNELS.windowClosing) === true,
    start: () => ipcRenderer.send(CHANNELS.start),
    reconnect: () => ipcRenderer.send(CHANNELS.reconnect),
    answer: (id: string, yes: boolean) => ipcRenderer.send(CHANNELS.answer, { id, yes }),
    send: (text: string) => ipcRenderer.send(CHANNELS.send, text),
    watchSession: (pane: SessionPane, agentId: string) => ipcRenderer.send(CHANNELS.sessionWatch, pane, agentId),
    sendSession: (pane: SessionPane, text: string) => ipcRenderer.send(CHANNELS.sessionSend, pane, text),
    unwatchSession: (pane: SessionPane) => ipcRenderer.send(CHANNELS.sessionUnwatch, pane),
    reportSessionShown: (agentId: string | undefined) => ipcRenderer.send(CHANNELS.sessionShown, agentId),
    reportComposerDraft: (agentId: string | undefined, text: string) => ipcRenderer.send(CHANNELS.composerDraft, agentId, text),
    updateState: async () => (await ipcRenderer.invoke(CHANNELS.updateState)) as UpdateState | undefined,
    updateAct: (action: UpdateAction) => ipcRenderer.send(CHANNELS.update, action),
    setTitleBarHeight: (height: number) => ipcRenderer.send(CHANNELS.titleBar, height),
    setWindowBackground: (color: string) => ipcRenderer.send(CHANNELS.windowBackground, color),
    setTheme: (choice: ThemeChoice) => ipcRenderer.send(CHANNELS.theme, choice),
    loadImportedThemes: async () => (await ipcRenderer.invoke(CHANNELS.themesLoad)) as readonly ImportedThemeSummary[],
    runExtensionCommand: async (command: string, pick?: string, onProgress?: (result: ExtensionCommandResult) => void, frameName?: string) => {
        const token = onProgress === undefined ? undefined : crypto.randomUUID();
        const handler = (_event: unknown, id: string, result: ExtensionCommandResult): void => {
            if (id === token) onProgress?.(result);
        };
        if (token !== undefined) ipcRenderer.on(CHANNELS.extensionCommandProgress, handler);
        try {
            return (await ipcRenderer.invoke(CHANNELS.extensionCommand, command, pick, token, frameName)) as ExtensionCommandResult;
        } finally {
            if (token !== undefined) ipcRenderer.off(CHANNELS.extensionCommandProgress, handler);
        }
    },
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
    readDesktopExtensionMain: async (id: string) =>
        (await ipcRenderer.invoke(CHANNELS.desktopExtensionMain, id)) as ExtensionMainResult,
    logDesktopExtension: (id: string, level: ExtensionLogLevel, text: string) =>
        ipcRenderer.send(CHANNELS.desktopExtensionLog, id, level, text),
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
    createSession: async (workspace: string | undefined, approvalMode?: string, notesOffer?: boolean) => {
        const result: unknown = await ipcRenderer.invoke(CHANNELS.sessionCreate, workspace, approvalMode, notesOffer);
        return result as CreateSessionResult;
    },
    branchSession: async (agentId: string, boundaryId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionBranch, agentId, boundaryId)) as BranchSessionResult,
    cloneSession: async (agentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionClone, agentId)) as BranchSessionResult,
    openSidekick: async (primaryAgentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sidekickOpen, primaryAgentId)) as OpenSidekickResult,
    syncSidekick: async (sidekickAgentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sidekickSync, sidekickAgentId)) as SyncSidekickResult,
    closeSession: async (agentId: string) =>
        (await ipcRenderer.invoke(CHANNELS.sessionClose, agentId)) as CloseSessionResult,
    setSessionArchived: async (agentId: string, archived: boolean) =>
        (await ipcRenderer.invoke(CHANNELS.sessionArchive, agentId, archived)) as { readonly ok: true } | { readonly ok: false; readonly reason: string },
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
    openLocalPreview: async (root: string, path: string) => await ipcRenderer.invoke(CHANNELS.previewOpen, root, path),
    closeLocalPreview: (token: string) => ipcRenderer.send(CHANNELS.previewClose, token),
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
    readIncludedExtensions: async () => (await ipcRenderer.invoke(CHANNELS.includedExtensionsRead)) as IncludedExtensionsResult,
    editAssignment: async (change: AssignmentChange) =>
        (await ipcRenderer.invoke(CHANNELS.assignmentsEdit, change)) as AssignmentWriteResult,
    assignToAll: async (provider: string, model: string) =>
        (await ipcRenderer.invoke(CHANNELS.assignmentsAll, provider, model)) as AssignAllResult,
    searchSessions: async (request: SessionSearchRequest) =>
        (await ipcRenderer.invoke(CHANNELS.sessionsSearch, request)) as SessionSearchResult,
    readExtensionFailures: async () =>
        (await ipcRenderer.invoke(CHANNELS.extensionFailures)) as ExtensionFailuresResult,
    measureStorage: async (refresh: boolean) =>
        (await ipcRenderer.invoke(CHANNELS.storageMeasure, refresh)) as StorageMeasured,
    previewStorageCleanup: async (area: StorageCleanupArea, maxAgeDays: number) =>
        (await ipcRenderer.invoke(CHANNELS.storageCleanupPreview, area, maxAgeDays)) as StoragePreviewed,
    runStorageCleanup: async (area: StorageCleanupArea, maxAgeDays: number) =>
        (await ipcRenderer.invoke(CHANNELS.storageCleanup, area, maxAgeDays)) as StorageCleaned,
    readNewSessionAgents: async (workspace: string | undefined) =>
        (await ipcRenderer.invoke(CHANNELS.newSessionAgents, workspace)) as NewSessionAgentsResult,
    readFolderCustomizations: async (workspace: string | undefined) =>
        (await ipcRenderer.invoke(CHANNELS.folderCustomizations, workspace)) as FolderCustomizationsResult,
    readAnnexPages: async () => (await ipcRenderer.invoke(CHANNELS.annexPages)) as AnnexPagesResult,
    openAnnexPage: async (path: string) => (await ipcRenderer.invoke(CHANNELS.annexOpen, path)) === true,
    browser: async (command: string, value?: string | number | boolean | null | BrowserBounds | BrowserHandoffAnswer | BrowserToolsApproval) =>
        (await ipcRenderer.invoke(CHANNELS.browser, command, value)) as BrowserState,
    revealFolder: async (folder: string) => (await ipcRenderer.invoke(CHANNELS.folderReveal, folder)) === true,
    onEvent: (listener: (event: DesktopEvent) => void) => {
        const handler = (_event: unknown, payload: DesktopEvent): void => listener(payload);
        ipcRenderer.on(CHANNELS.event, handler);
        return () => ipcRenderer.off(CHANNELS.event, handler);
    },
};

contextBridge.exposeInMainWorld("veraDesktop", bridge);
