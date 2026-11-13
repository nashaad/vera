import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type WebContents } from "electron";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { AgentStartError, createAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import { selectedVeraHome } from "../../../src/profile-paths.ts";
import type {
    BranchSessionResult,
    CloseSessionResult,
    CreateSessionResult,
    DesktopEvent,
    FilePreview,
    FolderListing,
    SessionPane,
} from "../../ui/src/protocol/bridge.ts";
import { NO_PINS } from "../../ui/src/protocol/pins.ts";
import type { ThemeImportResult } from "../../ui/src/protocol/themes.ts";
import { DEFAULT_THEME, importedThemeSlug, isThemeChoice, type ThemeChoice } from "../../ui/src/theme/tokens.ts";
import { annexAddress, readAnnexPages } from "./annex-requests.ts";
import { buildMenuTemplate } from "./app-menu.ts";
import { AssignmentService } from "./assignments.ts";
import { BootSession } from "./boot.ts";
import { CHANNELS } from "./channels.ts";
import { DEFAULT_DESKTOP_FLAGS, flagsPath, readFlags } from "./desktop-flags.ts";
import { existingFolders, folderListArgument } from "./folder-existence.ts";
import { readFilePreview } from "./file-preview.ts";
import { listFolder, pathArgument } from "./folder-listing.ts";
import { readBranch } from "./git-branch.ts";
import { HostPipe } from "./host-pipe.ts";
import { LayoutStore, layoutPath } from "./layout-store.ts";
import { ASSIGNMENT_TASK_FILE, ASSIGNMENT_TASK_SERVICE, changeArgument, parseAssignmentTaskReply, type AssignmentTask } from "./model-assignments/task-protocol.ts";
import { modelArgument, providerArgument } from "./model-arguments.ts";
import {
    forgetProvider,
    operateModel,
    operationArgument,
    readModels,
    refreshProvider,
    workspaceArgument,
} from "./model-requests.ts";
import { pastedImageDirectory, savePastedImage } from "./pasted-image.ts";
import { PinStore, pinsPath } from "./pin-store.ts";
import { readExtensionFailures } from "./extension-requests.ts";
import { searchArgument, searchSessions } from "./search-requests.ts";
import { SessionPipe } from "./session-pipe.ts";
import { branchSession, cloneSession, closeSession, idArgument } from "./session-requests.ts";
import { shortcutCommand } from "./shortcuts.ts";
import { startTaskProcess } from "./tasks/process.ts";
import { TaskRunner } from "./tasks/runner.ts";
import { parseThemeTaskReply, THEME_TASK_FILE, THEME_TASK_SERVICE, type ThemeTask } from "./theme-import/task-protocol.ts";
import { ThemeService } from "./theme-service.ts";
import { themesDirectory } from "./theme-store.ts";
import { parseWindowBackground } from "./window-background.ts";

const MAX_SEND_BYTES = 1_048_576;
const MAX_AGENT_ID_CHARS = 256;
const TRAFFIC_LIGHT_INSET_X = 14;
const TRAFFIC_LIGHT_SIZE = 14;
const TITLE_BAR_HEIGHT_RANGE = { min: 24, max: 96 };
// Matches the page's header height at the default density; the page reports the real one on load.
const TITLE_BAR_HEIGHT_INITIAL = 39;

// Chromium's default userData sits outside VERA_HOME; keep a trial home self-contained.
const userData = join(selectedVeraHome(), "machine", "desktop", "chromium");
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);

let window: BrowserWindow | undefined;
let boot: BootSession | undefined;
let stopping = false;
let activeTheme: ThemeChoice = DEFAULT_THEME;
// Set from the ready event; cleared on disconnect, failure, a new boot, or app stop.
let hostSocketPath: string | undefined;
// The annex base URL from the last page list the window read; the browser frame may only load from it.
let annexUrl: string | undefined;

const pipe = new HostPipe(sendEvent);
const sessionPanes: Readonly<Record<SessionPane, SessionPipe>> = {
    main: new SessionPipe(sendEvent, "main"),
    companion: new SessionPipe(sendEvent, "companion"),
    probe: new SessionPipe(sendEvent, "probe"),
};
const panes = Object.values(sessionPanes);
const layoutStore = new LayoutStore(layoutPath(selectedVeraHome()));
const pinStore = new PinStore(pinsPath(selectedVeraHome()));
const assignmentTasks = new TaskRunner(() => startTaskProcess<AssignmentTask>(ASSIGNMENT_TASK_FILE, ASSIGNMENT_TASK_SERVICE), parseAssignmentTaskReply);
const assignments = new AssignmentService(selectedVeraHome(), (task) => assignmentTasks.run(task));
const themeTasks = new TaskRunner(() => startTaskProcess<ThemeTask>(THEME_TASK_FILE, THEME_TASK_SERVICE), parseThemeTaskReply);
const themeService = new ThemeService(themesDirectory(selectedVeraHome()), (task) => themeTasks.run(task), undefined, () => installMenu());

function sendEvent(event: DesktopEvent): void {
    if (window === undefined || window.isDestroyed()) return;
    window.webContents.send(CHANNELS.event, event);
}

function receiveEvent(event: DesktopEvent): void {
    sendEvent(event);
    if (event.type === "ready") {
        hostSocketPath = event.socketPath;
        pipe.connect(event.socketPath);
        for (const pane of panes) pane.connect(event.socketPath);
    } else if (event.type === "disconnected" || event.type === "failed") {
        hostSocketPath = undefined;
    }
}

function startBoot(): void {
    boot?.cancel();
    hostSocketPath = undefined;
    pipe.close();
    for (const pane of panes) pane.close();
    boot = new BootSession(selectedVeraHome(), receiveEvent);
    boot.start();
}

// Rebuilt when the page reports a theme or the imported themes change, so the View menu lists and checks them.
function installMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(
        buildMenuTemplate(process.platform, (id) => sendEvent({ type: "command", id }), activeTheme, themeService.themes()),
    ));
}

function shutdown(): void {
    if (stopping) return;
    stopping = true;
    boot?.cancel();
    boot = undefined;
    hostSocketPath = undefined;
    pipe.close();
    for (const pane of panes) pane.close();
}

function paneArgument(value: unknown): SessionPipe | undefined {
    return value === "main" || value === "companion" || value === "probe" ? sessionPanes[value] : undefined;
}

function fromWindow(event: { readonly sender: WebContents }): boolean {
    return window !== undefined && event.sender === window.webContents;
}

function onAnnex(url: string): boolean {
    if (url === "about:blank" || url === "about:srcdoc") return true;
    if (annexUrl === undefined) return false;
    try {
        return new URL(url).origin === new URL(annexUrl).origin;
    } catch {
        return false;
    }
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
        // The page draws its own header on macOS; other platforms keep the system title bar.
        ...(process.platform === "darwin"
            ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLightPosition(TITLE_BAR_HEIGHT_INITIAL) }
            : {}),
        webPreferences: {
            preload: join(import.meta.dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    created.once("ready-to-show", () => created.show());
    const sendShown = (): void => sendEvent({ type: "window_shown", shown: created.isVisible() && !created.isMinimized() });
    created.on("show", sendShown);
    created.on("hide", sendShown);
    created.on("minimize", sendShown);
    created.on("restore", sendShown);
    // The window only ever shows the bundled page.
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    // The right pane's browser frame stays on the annex; links elsewhere go nowhere.
    created.webContents.on("will-frame-navigate", (event) => {
        if (event.isMainFrame) return;
        if (!onAnnex(event.url)) event.preventDefault();
    });
    // A shortcut handled here never reaches the page or the menu, so it runs once.
    created.webContents.on("before-input-event", (event, input) => {
        const command = shortcutCommand(input, process.platform);
        if (command === undefined) return;
        event.preventDefault();
        sendEvent({ type: "command", id: command });
    });
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
ipcMain.on(CHANNELS.sessionWatch, (event, pane: unknown, agentId: unknown) => {
    const target = paneArgument(pane);
    if (!fromWindow(event) || target === undefined) return;
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > MAX_AGENT_ID_CHARS) return;
    target.watch(agentId);
});
ipcMain.on(CHANNELS.sessionSend, (event, pane: unknown, text: unknown) => {
    const target = paneArgument(pane);
    if (!fromWindow(event) || target === undefined || typeof text !== "string" || text.length > MAX_SEND_BYTES) return;
    target.send(text);
});
ipcMain.on(CHANNELS.sessionUnwatch, (event, pane: unknown) => {
    if (fromWindow(event)) paneArgument(pane)?.unwatch();
});
ipcMain.handle(CHANNELS.sessionBranch, async (event, agentId: unknown, boundaryId: unknown): Promise<BranchSessionResult> => {
    const source = idArgument(agentId);
    const boundary = idArgument(boundaryId);
    if (!fromWindow(event) || source === undefined || boundary === undefined) return { ok: false, reason: "Choose a prompt to fork from." };
    return branchSession(hostSocketPath, source, boundary);
});
ipcMain.handle(CHANNELS.sessionClone, async (event, agentId: unknown): Promise<BranchSessionResult> => {
    const source = idArgument(agentId);
    if (!fromWindow(event) || source === undefined) return { ok: false, reason: "Open a session to clone." };
    return cloneSession(hostSocketPath, source);
});
ipcMain.handle(CHANNELS.sessionClose, async (event, agentId: unknown): Promise<CloseSessionResult> => {
    const target = idArgument(agentId);
    if (!fromWindow(event) || target === undefined) return { ok: false, reason: "Choose a session to stop." };
    return closeSession(hostSocketPath, target);
});
ipcMain.handle(CHANNELS.layoutLoad, (event) => (fromWindow(event) ? layoutStore.load() ?? null : null));
ipcMain.on(CHANNELS.layoutSave, (event, layout: unknown) => {
    if (fromWindow(event)) layoutStore.save(layout);
});
ipcMain.handle(CHANNELS.pinsLoad, (event) => (fromWindow(event) ? pinStore.load() ?? NO_PINS : NO_PINS));
ipcMain.on(CHANNELS.pinsSave, (event, pins: unknown) => {
    if (fromWindow(event)) pinStore.save(pins);
});
ipcMain.handle(CHANNELS.flagsLoad, (event) => (fromWindow(event) ? readFlags(flagsPath(selectedVeraHome())) : DEFAULT_DESKTOP_FLAGS));
ipcMain.on(CHANNELS.titleBar, (event, height: unknown) => {
    if (!fromWindow(event) || process.platform !== "darwin") return;
    if (typeof height !== "number" || !Number.isFinite(height)) return;
    const clamped = Math.min(Math.max(height, TITLE_BAR_HEIGHT_RANGE.min), TITLE_BAR_HEIGHT_RANGE.max);
    window?.setWindowButtonPosition(trafficLightPosition(clamped));
});
ipcMain.on(CHANNELS.theme, (event, choice: unknown) => {
    if (!fromWindow(event) || typeof choice !== "string" || !isThemeChoice(choice) || choice === activeTheme) return;
    const slug = importedThemeSlug(choice);
    if (slug !== undefined && !themeService.has(slug)) return;
    activeTheme = choice;
    installMenu();
});
ipcMain.handle(CHANNELS.themesLoad, (event) => (fromWindow(event) ? themeService.load() : []));
ipcMain.handle(CHANNELS.themeImport, async (event): Promise<ThemeImportResult> => {
    if (!fromWindow(event) || window === undefined) return { ok: false, reason: "That window cannot import themes." };
    const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [{ name: "VS Code themes", extensions: ["json", "jsonc", "vsix"] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return { ok: true, imported: [], themes: themeService.themes(), skipped: [] };
    return themeService.importFile(path);
});
ipcMain.handle(CHANNELS.themesInstalled, async (event) =>
    fromWindow(event) ? themeService.listInstalled() : { ok: false, reason: "That window cannot list themes." });
ipcMain.handle(CHANNELS.themeInstalledImport, async (event, key: unknown): Promise<ThemeImportResult> =>
    fromWindow(event) && typeof key === "string" ? themeService.importInstalled(key) : { ok: false, reason: "That is not a theme in the list." });
// A mode name the host can look up; anything else starts the session with the host default.
const APPROVAL_MODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

ipcMain.handle(
    CHANNELS.sessionCreate,
    async (event, workspace: unknown, approvalMode: unknown): Promise<CreateSessionResult> => {
        if (!fromWindow(event)) return { ok: false, reason: "The host is not running." };
        if (hostSocketPath === undefined) return { ok: false, reason: "The host is not running." };
        // No folder asks for a chat; a folder that is given must be an absolute path.
        let folder: string | undefined;
        if (workspace !== undefined && workspace !== null) {
            if (typeof workspace !== "string" || !isAbsolute(workspace)) return { ok: false, reason: "Choose a folder first." };
            folder = workspace;
        }
        const mode = typeof approvalMode === "string" && APPROVAL_MODE_PATTERN.test(approvalMode) ? approvalMode : undefined;
        try {
            const ready = await createAgentThroughHost(hostSocketPath, folder, mode);
            return { ok: true, agentId: ready.id, workspace: ready.workspace };
        } catch (error) {
            if (error instanceof AgentStartError && error.reason !== undefined) {
                return { ok: false, reason: error.reason };
            }
            return { ok: false, reason: folder === undefined ? "Vera could not start a chat." : "Vera could not start a session in that folder." };
        }
    },
);
ipcMain.handle(CHANNELS.foldersExisting, async (event, folders: unknown): Promise<readonly string[]> =>
    fromWindow(event) ? existingFolders(folderListArgument(folders)) : []);
ipcMain.handle(CHANNELS.folderChoose, async (event): Promise<string | undefined> => {
    if (!fromWindow(event) || window === undefined) return undefined;
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
});
ipcMain.handle(CHANNELS.imagesChoose, async (event): Promise<readonly string[]> => {
    if (!fromWindow(event) || window === undefined) return [];
    const result = await dialog.showOpenDialog(window, {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    return result.canceled ? [] : result.filePaths;
});
ipcMain.handle(CHANNELS.imagePaste, async (event, data: unknown, mediaType: unknown): Promise<string | undefined> => {
    if (!fromWindow(event) || !(data instanceof Uint8Array) || typeof mediaType !== "string") return undefined;
    return savePastedImage(pastedImageDirectory(selectedVeraHome()), data, mediaType).catch(() => undefined);
});
ipcMain.handle(CHANNELS.branchRead, async (event, folder: unknown): Promise<string | undefined> => {
    if (!fromWindow(event) || typeof folder !== "string" || !isAbsolute(folder)) return undefined;
    return readBranch(folder);
});
ipcMain.handle(CHANNELS.folderList, async (event, folder: unknown): Promise<FolderListing> => {
    const path = pathArgument(folder);
    if (!fromWindow(event) || path === undefined) return { ok: false, reason: "That is not a folder path." };
    return listFolder(path);
});
ipcMain.handle(CHANNELS.fileRead, async (event, file: unknown): Promise<FilePreview> => {
    const path = pathArgument(file);
    if (!fromWindow(event) || path === undefined) return { ok: false, reason: "That is not a file path." };
    return readFilePreview(path);
});
ipcMain.handle(CHANNELS.modelsRead, (event, workspace: unknown) =>
    fromWindow(event) ? readModels(hostSocketPath, workspaceArgument(workspace)) : undefined);
ipcMain.handle(CHANNELS.catalogRefresh, (event, provider: unknown, workspace: unknown) => {
    const id = providerArgument(provider);
    if (!fromWindow(event) || id === undefined) return { ok: false, reason: "That is not a provider Vera knows." };
    return refreshProvider(hostSocketPath, id, workspaceArgument(workspace));
});
ipcMain.handle(CHANNELS.providerForget, (event, provider: unknown, workspace: unknown) => {
    const id = providerArgument(provider);
    if (!fromWindow(event) || id === undefined) return { ok: false, reason: "That is not a provider Vera knows." };
    return forgetProvider(hostSocketPath, id, workspaceArgument(workspace));
});
ipcMain.handle(CHANNELS.modelOperate, (event, operation: unknown, provider: unknown, model: unknown, workspace: unknown) => {
    const kind = operationArgument(operation);
    const id = providerArgument(provider);
    const name = modelArgument(model);
    if (!fromWindow(event) || kind === undefined || id === undefined || name === undefined) {
        return { ok: false, reason: "That is not a model Vera knows." };
    }
    return operateModel(hostSocketPath, kind, id, name, workspaceArgument(workspace));
});
ipcMain.handle(CHANNELS.assignmentsRead, (event) =>
    fromWindow(event) ? assignments.read() : { ok: false, reason: "That window cannot read assignments." });
ipcMain.handle(CHANNELS.assignmentsEdit, (event, change: unknown) => {
    const edit = changeArgument(change);
    if (!fromWindow(event) || edit === undefined) return { ok: false, reason: "That is not an assignment change." };
    return assignments.edit(edit);
});
ipcMain.handle(CHANNELS.assignmentsAll, (event, provider: unknown, model: unknown) => {
    const id = providerArgument(provider);
    const name = modelArgument(model);
    if (!fromWindow(event) || id === undefined || name === undefined) return { ok: false, reason: "That is not a model Vera knows." };
    return assignments.assignAll(id, name);
});
ipcMain.handle(CHANNELS.sessionsSearch, (event, request: unknown) => {
    const parsed = searchArgument(request);
    if (!fromWindow(event) || parsed === undefined) return { ok: false, reason: "That search could not be sent." };
    return searchSessions(hostSocketPath, parsed);
});
ipcMain.handle(CHANNELS.folderReveal, async (event, folder: unknown): Promise<boolean> => {
    if (!fromWindow(event) || typeof folder !== "string" || !isAbsolute(folder)) return false;
    return (await shell.openPath(folder)) === "";
});
ipcMain.handle(CHANNELS.extensionFailures, (event) =>
    fromWindow(event) ? readExtensionFailures(hostSocketPath) : { ok: false, reason: "The host is not running." });
ipcMain.handle(CHANNELS.annexPages, async (event) => {
    if (!fromWindow(event)) return { ok: false, reason: "The host is not running." };
    const result = await readAnnexPages(hostSocketPath);
    if (result.ok) annexUrl = result.url;
    return result;
});
ipcMain.handle(CHANNELS.annexOpen, async (event, path: unknown): Promise<boolean> => {
    const address = annexUrl === undefined ? undefined : annexAddress(annexUrl, path);
    if (!fromWindow(event) || address === undefined) return false;
    await shell.openExternal(address);
    return true;
});
ipcMain.on(CHANNELS.windowBackground, (event, value: unknown) => {
    if (!fromWindow(event)) return;
    const color = parseWindowBackground(value);
    if (color !== undefined) window?.setBackgroundColor(color);
});

app.on("before-quit", shutdown);
app.on("window-all-closed", () => app.quit());
app.whenReady().then(() => {
    themeService.load();
    installMenu();
    window = createWindow();
});
